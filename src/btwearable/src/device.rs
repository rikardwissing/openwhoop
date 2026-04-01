use anyhow::anyhow;
use btleplug::{
    api::{Central, CharPropFlags, Characteristic, Peripheral as _, WriteType},
    platform::{Adapter, Peripheral},
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
use btwearable_codec::{
    WearableData, WearablePacket,
    constants::{
        CMD_FROM_STRAP, CMD_TO_STRAP, DATA_FROM_STRAP, EVENTS_FROM_STRAP, MEMFAULT, WEARABLE_SERVICE,
    },
};

use crate::{db::DatabaseHandler, btwearable::BtWearable};

pub struct WearableDevice {
    peripheral: Peripheral,
    wearable: BtWearable,
    debug_packets: bool,
    adapter: Adapter,
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
        let packet = packet.framed_packet()?;
        self.peripheral
            .write(
                &Self::create_char(CMD_TO_STRAP),
                &packet,
                WriteType::WithoutResponse,
            )
            .await?;
        Ok(())
    }

    pub async fn sync_history(&mut self, should_exit: Arc<AtomicBool>) -> anyhow::Result<()> {
        let mut notifications = self.peripheral.notifications().await?;

        self.send_command(WearablePacket::history_start()).await?;

        'a: loop {
            if should_exit.load(Ordering::SeqCst) {
                break;
            }
            let notification = notifications.next();
            let sleep_ = sleep(Duration::from_secs(10));

            tokio::select! {
                _ = sleep_ => {
                    if self.on_sleep().await? {
                        error!("Wearable disconnected");
                        for _ in 0..5{
                            if self.connect().await.is_ok() {
                                self.initialize().await?;
                                self.send_command(WearablePacket::history_start()).await?;
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
                }
            }
        }

        Ok(())
    }

    pub async fn stream_hr(&mut self, should_exit: Arc<AtomicBool>) -> anyhow::Result<()> {
        self.subscribe(DATA_FROM_STRAP).await?;
        self.subscribe(CMD_FROM_STRAP).await?;

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
                        Ok(WearableData::Event { .. } | WearableData::UnknownEvent { .. }) => {}
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
        self.subscribe(CMD_FROM_STRAP).await?;

        let mut notifications = self.peripheral.notifications().await?;
        self.send_command(WearablePacket::version()).await?;

        let timeout_duration = Duration::from_secs(5);
        match timeout(timeout_duration, notifications.next()).await {
            Ok(Some(notification)) => {
                let packet = WearablePacket::from_data(notification.value)?;
                let data = WearableData::from_packet(packet)?;
                if let WearableData::VersionInfo { harvard, boylston } = data {
                    info!("version harvard {} boylston {}", harvard, boylston);
                }
                Ok(())
            }
            Ok(None) => Err(anyhow!("stream ended unexpectedly")),
            Err(_) => Err(anyhow!("timed out waiting for version notification")),
        }
    }

    pub async fn get_alarm(&mut self) -> anyhow::Result<WearableData> {
        self.subscribe(CMD_FROM_STRAP).await?;

        let mut notifications = self.peripheral.notifications().await?;
        self.send_command(WearablePacket::get_alarm_time()).await?;

        let timeout_duration = Duration::from_secs(30);
        match timeout(timeout_duration, notifications.next()).await {
            Ok(Some(notification)) => {
                let packet = WearablePacket::from_data(notification.value)?;
                let data = WearableData::from_packet(packet)?;
                Ok(data)
            }
            Ok(None) => Err(anyhow!("stream ended unexpectedly")),
            Err(_) => Err(anyhow!("timed out waiting for alarm notification")),
        }
    }
}
