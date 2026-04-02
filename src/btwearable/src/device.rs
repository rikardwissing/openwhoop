use anyhow::anyhow;
use btleplug::{
    api::{Central, CharPropFlags, Characteristic, Peripheral as _, WriteType},
    platform::{Adapter, Peripheral},
};
use btwearable_codec::{
    WearableData, WearablePacket,
    constants::{
        CMD_FROM_STRAP, CMD_TO_STRAP, CommandNumber, DATA_FROM_STRAP, EVENTS_FROM_STRAP,
        EventNumber, MEMFAULT, MetadataType, PacketType, WEARABLE_SERVICE,
    },
};
use btwearable_entities::packets::Model;
use futures::StreamExt;
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

use crate::{btwearable::BtWearable, db::DatabaseHandler};

pub struct WearableDevice {
    peripheral: Peripheral,
    wearable: BtWearable,
    debug_packets: bool,
    adapter: Adapter,
}

#[derive(Debug, Default)]
pub struct BatteryProbeResult {
    pub battery_response: Option<WearableData>,
    pub extended_battery_response: Option<WearableData>,
    pub battery_event: Option<WearableData>,
    pub extended_battery_event: Option<WearableData>,
}

#[derive(Debug)]
pub struct CommandProbeEntry {
    pub uuid: Uuid,
    pub packet_type: Option<PacketType>,
    pub cmd: Option<u8>,
    pub payload: Vec<u8>,
    pub decoded: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct HistoryPeekMetadata {
    pub unix: u32,
    pub data: u32,
    pub cmd: MetadataType,
}

#[derive(Debug, Default)]
pub struct HistoryPeekSummary {
    pub notifications: usize,
    pub decoded_packets: usize,
    pub readings: usize,
    pub first_reading_unix: Option<u64>,
    pub last_reading_unix: Option<u64>,
    pub history_end_seen: bool,
    pub history_complete_seen: bool,
    pub timed_out: bool,
    pub stream_ended: bool,
    pub synced_to_db: bool,
    pub refreshed_metrics: bool,
    pub trailing_history_flushes: usize,
    pub metadata: Vec<HistoryPeekMetadata>,
}

impl WearableDevice {
    pub fn new(
        peripheral: Peripheral,
        adapter: Adapter,
        db: DatabaseHandler,
        debug_packets: bool,
    ) -> Self {
        Self {
            peripheral,
            wearable: BtWearable::new(db),
            debug_packets,
            adapter,
        }
    }

    pub async fn connect(&mut self) -> anyhow::Result<()> {
        self.peripheral.connect().await?;
        let _ = self.adapter.stop_scan().await;
        self.peripheral.discover_services().await?;
        self.wearable.packet = None;
        Ok(())
    }

    pub async fn is_connected(&mut self) -> anyhow::Result<bool> {
        let is_connected = self.peripheral.is_connected().await?;
        Ok(is_connected)
    }

    fn create_char(characteristic: Uuid) -> Characteristic {
        Characteristic {
            uuid: characteristic,
            service_uuid: WEARABLE_SERVICE,
            properties: CharPropFlags::empty(),
            descriptors: BTreeSet::new(),
        }
    }

    async fn subscribe(&self, char: Uuid) -> anyhow::Result<()> {
        self.peripheral.subscribe(&Self::create_char(char)).await?;
        Ok(())
    }

    pub async fn initialize(&mut self) -> anyhow::Result<()> {
        self.subscribe(DATA_FROM_STRAP).await?;
        self.subscribe(CMD_FROM_STRAP).await?;
        self.subscribe(EVENTS_FROM_STRAP).await?;
        self.subscribe(MEMFAULT).await?;

        self.send_command(WearablePacket::hello_harvard()).await?;
        self.send_command(WearablePacket::set_time()?).await?;
        self.send_command(WearablePacket::get_name()).await?;

        self.send_command(WearablePacket::enter_high_freq_sync())
            .await?;
        Ok(())
    }

    pub async fn send_command(&mut self, packet: WearablePacket) -> anyhow::Result<()> {
        self.write_command(packet, WriteType::WithoutResponse).await
    }

    pub async fn send_command_with_response(
        &mut self,
        packet: WearablePacket,
    ) -> anyhow::Result<()> {
        self.write_command(packet, WriteType::WithResponse).await
    }

    async fn write_command(
        &mut self,
        packet: WearablePacket,
        write_type: WriteType,
    ) -> anyhow::Result<()> {
        let packet = packet.framed_packet()?;
        self.peripheral
            .write(&Self::create_char(CMD_TO_STRAP), &packet, write_type)
            .await?;
        Ok(())
    }

    pub async fn sync_history(&mut self, should_exit: Arc<AtomicBool>) -> anyhow::Result<()> {
        self.sync_history_internal(None, should_exit).await
    }

    pub async fn sync_history_from_pointer(
        &mut self,
        pointer: u32,
        should_exit: Arc<AtomicBool>,
    ) -> anyhow::Result<()> {
        self.sync_history_internal(Some(pointer), should_exit).await
    }

    pub async fn peek_history(
        &mut self,
        replay_pointer: Option<u32>,
        listen_duration: Duration,
        sync_db: bool,
        refresh_metrics: bool,
    ) -> anyhow::Result<HistoryPeekSummary> {
        self.wearable.reset_history_sync_state();
        let mut notifications = self.peripheral.notifications().await?;
        self.start_history_transfer(replay_pointer).await?;

        let mut summary = HistoryPeekSummary {
            synced_to_db: sync_db,
            ..HistoryPeekSummary::default()
        };
        let deadline = tokio::time::Instant::now() + listen_duration;

        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let notification = match timeout(remaining, notifications.next()).await {
                Ok(Some(notification)) => notification,
                Ok(None) => {
                    summary.stream_ended = true;
                    break;
                }
                Err(_) => {
                    summary.timed_out = true;
                    break;
                }
            };

            summary.notifications += 1;
            let packet = if sync_db {
                self.wearable
                    .database
                    .create_packet(notification.uuid, notification.value.clone())
                    .await?
            } else {
                Model {
                    id: 0,
                    uuid: notification.uuid,
                    bytes: notification.value,
                }
            };

            let Some(data) = self.wearable.decode_packet(packet)? else {
                continue;
            };
            summary.decoded_packets += 1;

            match &data {
                WearableData::HistoryReading(reading) if reading.is_valid() => {
                    summary.readings += 1;
                    summary.first_reading_unix = summary
                        .first_reading_unix
                        .map(|unix| unix.min(reading.unix))
                        .or(Some(reading.unix));
                    summary.last_reading_unix = summary
                        .last_reading_unix
                        .map(|unix| unix.max(reading.unix))
                        .or(Some(reading.unix));
                }
                WearableData::HistoryMetadata { unix, data, cmd } => {
                    summary.metadata.push(HistoryPeekMetadata {
                        unix: *unix,
                        data: *data,
                        cmd: *cmd,
                    });
                    if matches!(cmd, MetadataType::HistoryEnd) {
                        summary.history_end_seen = true;
                        break;
                    }
                    if matches!(cmd, MetadataType::HistoryComplete) {
                        summary.history_complete_seen = true;
                        break;
                    }
                }
                _ => {}
            }

            if sync_db {
                self.wearable
                    .ingest_decoded_data_without_history_ack(data)
                    .await?;
            }
        }

        if sync_db {
            summary.trailing_history_flushes =
                self.wearable.flush_pending_history_readings().await?;
            if refresh_metrics {
                self.wearable.refresh_metrics().await?;
                summary.refreshed_metrics = true;
            }
        }

        Ok(summary)
    }

    async fn sync_history_internal(
        &mut self,
        replay_pointer: Option<u32>,
        should_exit: Arc<AtomicBool>,
    ) -> anyhow::Result<()> {
        self.wearable.reset_history_sync_state();
        let mut notifications = self.peripheral.notifications().await?;

        self.start_history_transfer(replay_pointer).await?;

        'a: loop {
            if should_exit.load(Ordering::SeqCst) {
                info!("History sync interrupted by user");
                break;
            }
            let notification = notifications.next();
            let sleep_ = sleep(Duration::from_secs(10));

            tokio::select! {
                _ = sleep_ => {
                    if self.on_sleep().await? {
                        error!("Wearable disconnected");
                        for attempt in 1..=5{
                            info!("Reconnect attempt {attempt}/5 during history sync");
                            if self.connect().await.is_ok() {
                                info!("Reconnected, reinitializing history sync");
                                self.initialize().await?;
                                self.wearable.reset_history_sync_state();
                                self.start_history_transfer(replay_pointer).await?;
                                continue 'a;
                            }

                            sleep(Duration::from_secs(10)).await;
                        }

                        break;
                    }
                },
                Some(notification) = notification => {
                    let packet = match self.debug_packets {
                        true => self.wearable.store_packet(notification).await?,
                        false => Model { id: 0, uuid: notification.uuid, bytes: notification.value },
                    };

                    if let Some(packet) = self.wearable.handle_packet(packet).await?{
                        self.send_command(packet).await?;
                    }

                    if self.wearable.history_complete {
                        info!("History sync marked complete, exiting sync loop");
                        break;
                    }
                }
            }
        }

        Ok(())
    }

    async fn start_history_transfer(&mut self, replay_pointer: Option<u32>) -> anyhow::Result<()> {
        if let Some(pointer) = replay_pointer {
            info!(
                "Rewinding device history to read pointer {} (0x{pointer:08x}) before sync",
                pointer
            );
            self.send_command(WearablePacket::abort_historical_transmits())
                .await?;
            self.send_command(WearablePacket::set_read_pointer(pointer))
                .await?;
        } else {
            info!("Requesting historical data from wearable");
        }

        self.send_command(WearablePacket::history_start()).await?;
        Ok(())
    }

    pub async fn refresh_metrics(&self) -> anyhow::Result<()> {
        self.wearable.refresh_metrics().await
    }

    pub async fn stream_hr(&mut self, should_exit: Arc<AtomicBool>) -> anyhow::Result<()> {
        self.subscribe(DATA_FROM_STRAP).await?;
        self.subscribe(CMD_FROM_STRAP).await?;
        self.subscribe(EVENTS_FROM_STRAP).await?;

        let mut notifications = self.peripheral.notifications().await?;
        self.send_command(WearablePacket::toggle_realtime_hr(true))
            .await?;

        loop {
            if should_exit.load(Ordering::SeqCst) {
                break;
            }

            let notification = notifications.next();
            let sleep_ = sleep(Duration::from_secs(30));

            tokio::select! {
                _ = sleep_ => {
                    warn!("Timed out waiting for HR data");
                    break;
                },
                Some(notification) = notification => {
                    let packet = match WearablePacket::from_data(notification.value) {
                        Ok(packet) => packet,
                        Err(_) => continue,
                    };

                    match WearableData::from_packet(packet) {
                        Ok(WearableData::RealtimeHr { unix, bpm }) => {
                            let time = chrono::DateTime::from_timestamp(i64::from(unix), 0)
                                .map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                                .unwrap_or_else(|| unix.to_string());
                            println!("{time} HR: {bpm} bpm");
                        }
                        Ok(WearableData::DeviceEvent { unix, event, .. }) => {
                            let time = chrono::DateTime::from_timestamp(i64::from(unix), 0)
                                .map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                                .unwrap_or_else(|| unix.to_string());
                            println!("{time} EVENT: {:?}", event);
                        }
                        Ok(WearableData::Event { .. } | WearableData::UnknownEvent { .. }) => {}
                        Ok(WearableData::ConsoleLog { unix, log }) => {
                            let time = chrono::DateTime::from_timestamp(i64::from(unix), 0)
                                .map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                                .unwrap_or_else(|| unix.to_string());
                            println!("{time} LOG: {}", log.trim_end());
                        }
                        Ok(_) => {}
                        Err(_) => {}
                    }
                }
            }
        }

        if let Ok(true) = self.peripheral.is_connected().await {
            self.send_command(WearablePacket::toggle_realtime_hr(false))
                .await?;
        }

        Ok(())
    }

    async fn on_sleep(&mut self) -> anyhow::Result<bool> {
        let is_connected = self.peripheral.is_connected().await?;
        Ok(!is_connected)
    }

    pub async fn get_version(&mut self) -> anyhow::Result<()> {
        let data = self
            .read_command_response_or_event(WearablePacket::version(), None, Duration::from_secs(5))
            .await?;

        if let WearableData::VersionInfo { harvard, boylston } = data {
            info!("version harvard {} boylston {}", harvard, boylston);
            Ok(())
        } else {
            Err(anyhow!("unexpected version response: {:?}", data))
        }
    }

    pub async fn get_alarm(&mut self) -> anyhow::Result<WearableData> {
        self.read_command_response_or_event(
            WearablePacket::get_alarm_time(),
            None,
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn get_name(&mut self) -> anyhow::Result<String> {
        self.get_name_with_request(WearablePacket::get_name()).await
    }

    pub async fn set_name(&mut self, name: &str) -> anyhow::Result<String> {
        let request = WearablePacket::set_name(name)?;
        let command_name = CommandNumber::from_u8(request.cmd)
            .map(|command| format!("{command:?}"))
            .unwrap_or_else(|| format!("cmd=0x{:02x}", request.cmd));
        match timeout(
            Duration::from_secs(1),
            self.send_command_with_response(request),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                warn!(
                    "Name write via {command_name} timed out waiting for GATT ack; assuming the packet was dispatched"
                );
            }
        }
        sleep(Duration::from_millis(250)).await;
        Ok(name.to_string())
    }

    pub async fn get_battery(&mut self) -> anyhow::Result<WearableData> {
        self.read_command_response_or_event(
            WearablePacket::get_battery_level(),
            Some(EventNumber::BatteryLevel),
            Duration::from_secs(10),
        )
        .await
    }

    pub async fn get_body_status(&mut self) -> anyhow::Result<WearableData> {
        self.read_command_response_or_event(
            WearablePacket::get_body_location_and_status(),
            None,
            Duration::from_secs(10),
        )
        .await
    }

    pub async fn get_extended_battery_info(&mut self) -> anyhow::Result<WearableData> {
        self.read_command_response_or_event(
            WearablePacket::get_extended_battery_info(),
            Some(EventNumber::ExtendedBatteryInformation),
            Duration::from_secs(10),
        )
        .await
    }

    pub async fn get_data_range(&mut self) -> anyhow::Result<WearableData> {
        self.read_command_response_or_event(
            WearablePacket::get_data_range(),
            None,
            Duration::from_secs(10),
        )
        .await
    }

    pub async fn stream_events(&mut self, should_exit: Arc<AtomicBool>) -> anyhow::Result<()> {
        self.subscribe(CMD_FROM_STRAP).await?;
        self.subscribe(EVENTS_FROM_STRAP).await?;
        self.subscribe(MEMFAULT).await?;

        let mut notifications = self.peripheral.notifications().await?;

        loop {
            if should_exit.load(Ordering::SeqCst) {
                break;
            }

            tokio::select! {
                _ = sleep(Duration::from_millis(250)) => {},
                notification = notifications.next() => {
                    let Some(notification) = notification else {
                        warn!("Device event stream ended unexpectedly");
                        break;
                    };

                    let packet = match WearablePacket::from_data(notification.value) {
                        Ok(packet) => packet,
                        Err(_) => continue,
                    };

                    match WearableData::from_packet(packet) {
                        Ok(WearableData::DeviceEvent { unix, event, payload }) => {
                            let time = chrono::DateTime::from_timestamp(i64::from(unix), 0)
                                .map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                                .unwrap_or_else(|| unix.to_string());
                            if payload.is_empty() {
                                println!("{time} EVENT: {:?}", event);
                            } else {
                                println!("{time} EVENT: {:?} payload={}", event, hex::encode(payload));
                            }
                        }
                        Ok(WearableData::Event { unix, event }) => {
                            let time = chrono::DateTime::from_timestamp(i64::from(unix), 0)
                                .map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                                .unwrap_or_else(|| unix.to_string());
                            println!("{time} EVENT: {:?}", event);
                        }
                        Ok(WearableData::UnknownEvent { unix, event }) => {
                            let time = chrono::DateTime::from_timestamp(i64::from(unix), 0)
                                .map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                                .unwrap_or_else(|| unix.to_string());
                            println!("{time} EVENT: unknown({event})");
                        }
                        Ok(WearableData::ConsoleLog { unix, log }) => {
                            let time = chrono::DateTime::from_timestamp(i64::from(unix), 0)
                                .map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                                .unwrap_or_else(|| unix.to_string());
                            println!("{time} LOG: {}", log.trim_end());
                        }
                        Ok(WearableData::RawCommandResponse { command, payload }) => {
                            println!("CMD {:?}: {}", command, hex::encode(payload));
                        }
                        Ok(_) => {}
                        Err(_) => {}
                    }
                }
            }
        }

        Ok(())
    }

    pub async fn probe_battery(&mut self) -> anyhow::Result<BatteryProbeResult> {
        self.subscribe(CMD_FROM_STRAP).await?;
        self.subscribe(EVENTS_FROM_STRAP).await?;

        let mut notifications = self.peripheral.notifications().await?;
        let mut result = BatteryProbeResult::default();

        self.send_command(WearablePacket::get_battery_level())
            .await?;
        self.send_command(WearablePacket::get_extended_battery_info())
            .await?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let notification = match timeout(remaining, notifications.next()).await {
                Ok(Some(notification)) => notification,
                Ok(None) | Err(_) => break,
            };

            let packet = match WearablePacket::from_data(notification.value) {
                Ok(packet) => packet,
                Err(_) => continue,
            };

            let data = match WearableData::from_packet(packet) {
                Ok(data) => data,
                Err(_) => continue,
            };

            match data {
                WearableData::RawCommandResponse {
                    command: btwearable_codec::constants::CommandNumber::GetBatteryLevel,
                    payload,
                } => {
                    result.battery_response = Some(WearableData::RawCommandResponse {
                        command: btwearable_codec::constants::CommandNumber::GetBatteryLevel,
                        payload,
                    });
                }
                WearableData::RawCommandResponse {
                    command: btwearable_codec::constants::CommandNumber::GetExtendedBatteryInfo,
                    payload,
                } => {
                    result.extended_battery_response = Some(WearableData::RawCommandResponse {
                        command: btwearable_codec::constants::CommandNumber::GetExtendedBatteryInfo,
                        payload,
                    });
                }
                WearableData::DeviceEvent {
                    unix,
                    event: EventNumber::BatteryLevel,
                    payload,
                } => {
                    result.battery_event = Some(WearableData::DeviceEvent {
                        unix,
                        event: EventNumber::BatteryLevel,
                        payload,
                    });
                }
                WearableData::DeviceEvent {
                    unix,
                    event: EventNumber::ExtendedBatteryInformation,
                    payload,
                } => {
                    result.extended_battery_event = Some(WearableData::DeviceEvent {
                        unix,
                        event: EventNumber::ExtendedBatteryInformation,
                        payload,
                    });
                }
                _ => {}
            }

            if result.battery_response.is_some()
                && result.extended_battery_response.is_some()
                && result.battery_event.is_some()
                && result.extended_battery_event.is_some()
            {
                break;
            }
        }

        Ok(result)
    }

    pub async fn probe_command(
        &mut self,
        packet: WearablePacket,
        write_with_response: bool,
        listen_duration: Duration,
    ) -> anyhow::Result<Vec<CommandProbeEntry>> {
        self.subscribe(DATA_FROM_STRAP).await?;
        self.subscribe(CMD_FROM_STRAP).await?;
        self.subscribe(EVENTS_FROM_STRAP).await?;
        self.subscribe(MEMFAULT).await?;

        let mut notifications = self.peripheral.notifications().await?;
        if write_with_response {
            self.send_command_with_response(packet).await?;
        } else {
            self.send_command(packet).await?;
        }

        let deadline = tokio::time::Instant::now() + listen_duration;
        let mut entries = Vec::new();
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let notification = match timeout(remaining, notifications.next()).await {
                Ok(Some(notification)) => notification,
                Ok(None) | Err(_) => break,
            };

            entries.push(Self::decode_probe_entry(
                notification.uuid,
                notification.value,
            ));
        }

        Ok(entries)
    }

    async fn read_command_response_or_event(
        &mut self,
        request: WearablePacket,
        expected_event: Option<EventNumber>,
        timeout_duration: Duration,
    ) -> anyhow::Result<WearableData> {
        self.subscribe(CMD_FROM_STRAP).await?;
        if expected_event.is_some() {
            self.subscribe(EVENTS_FROM_STRAP).await?;
        }

        let mut notifications = self.peripheral.notifications().await?;
        let expected_cmd = request.cmd;
        self.send_command(request).await?;
        let mut fallback_response = None;
        let deadline = tokio::time::Instant::now() + timeout_duration;

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                if let Some(data) = fallback_response {
                    return Ok(data);
                }
                return Err(anyhow!("timed out waiting for command response"));
            }

            match timeout(remaining, notifications.next()).await {
                Ok(Some(notification)) => {
                    let packet = WearablePacket::from_data(notification.value)?;
                    if let Some(expected_event) = expected_event {
                        if packet.packet_type == PacketType::Event
                            && packet.cmd == expected_event as u8
                        {
                            return WearableData::from_packet(packet).map_err(Into::into);
                        }
                    }

                    if packet.packet_type == PacketType::CommandResponse
                        && packet.cmd == expected_cmd
                    {
                        let data = WearableData::from_packet(packet)?;
                        if expected_event.is_none() {
                            return Ok(data);
                        }
                        fallback_response = Some(data);
                    }
                }
                Ok(None) => return Err(anyhow!("stream ended unexpectedly")),
                Err(_) => {
                    if let Some(data) = fallback_response {
                        return Ok(data);
                    }
                    return Err(anyhow!("timed out waiting for command response"));
                }
            }
        }
    }

    fn decode_name_response(data: WearableData) -> anyhow::Result<String> {
        match data {
            WearableData::RawCommandResponse { command, payload }
                if matches!(
                    command,
                    btwearable_codec::constants::CommandNumber::GetAdvertisingNameHarvard
                        | btwearable_codec::constants::CommandNumber::GetAdvertisingName
                ) =>
            {
                Self::decode_name_payload(&payload).ok_or_else(|| {
                    anyhow!(
                        "unable to decode advertising name response payload: {}",
                        hex::encode(payload)
                    )
                })
            }
            other => Err(anyhow!("unexpected device name response: {:?}", other)),
        }
    }

    async fn get_name_with_request(&mut self, request: WearablePacket) -> anyhow::Result<String> {
        self.get_name_with_request_timeout(request, Duration::from_secs(10))
            .await
    }

    async fn get_name_with_request_timeout(
        &mut self,
        request: WearablePacket,
        timeout_duration: Duration,
    ) -> anyhow::Result<String> {
        let data = self
            .read_command_response_or_event(request, None, timeout_duration)
            .await?;
        Self::decode_name_response(data)
    }

    fn decode_name_payload(payload: &[u8]) -> Option<String> {
        if let Some(name) = Self::normalize_name_bytes(payload) {
            return Some(name);
        }

        if let Some(name) = payload
            .strip_prefix(&[0x00])
            .and_then(Self::normalize_name_bytes)
        {
            return Some(name);
        }

        if let Some((&len, rest)) = payload.split_first() {
            let len = usize::from(len);
            if len > 0 && rest.len() >= len {
                if let Some(name) = Self::normalize_name_bytes(&rest[..len]) {
                    return Some(name);
                }
            }
        }

        payload
            .iter()
            .position(|byte| !byte.is_ascii_control() && *byte != 0)
            .and_then(|start| Self::normalize_name_bytes(&payload[start..]))
    }

    fn normalize_name_bytes(bytes: &[u8]) -> Option<String> {
        let bytes = bytes
            .iter()
            .copied()
            .take_while(|byte| *byte != 0)
            .collect::<Vec<_>>();

        if bytes.is_empty() {
            return None;
        }

        let name = String::from_utf8(bytes).ok()?;
        let name = name.trim().to_string();

        if name.is_empty() || name.chars().any(|character| character.is_control()) {
            return None;
        }

        Some(name)
    }

    fn decode_probe_entry(uuid: Uuid, bytes: Vec<u8>) -> CommandProbeEntry {
        let raw_hex = hex::encode(&bytes);

        let Ok(packet) = WearablePacket::from_data(bytes) else {
            return CommandProbeEntry {
                uuid,
                packet_type: None,
                cmd: None,
                payload: Vec::new(),
                decoded: Some(format!("raw={raw_hex}")),
            };
        };

        let decoded = match WearableData::from_packet(WearablePacket {
            packet_type: packet.packet_type,
            seq: packet.seq,
            cmd: packet.cmd,
            data: packet.data.clone(),
            partial: packet.partial,
            size: packet.size,
        }) {
            Ok(data) => Some(format!("{data:?}")),
            Err(error) => Some(format!("parse_error={error:?}")),
        };

        CommandProbeEntry {
            uuid,
            packet_type: Some(packet.packet_type),
            cmd: Some(packet.cmd),
            payload: packet.data,
            decoded,
        }
    }
}
