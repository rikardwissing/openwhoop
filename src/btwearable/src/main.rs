#[macro_use]
extern crate log;

use std::{
    io,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::anyhow;
#[cfg(target_os = "linux")]
use btleplug::api::BDAddr;
use btleplug::{
    api::{Central, Manager as _, Peripheral as _, ScanFilter},
    platform::{Adapter, Manager, Peripheral},
};
use btwearable::{
    BatteryProbeResult, BtWearable, CommandProbeEntry, HistoryPeekSummary, WearableDevice,
    algo::{ExerciseMetrics, SleepConsistencyAnalyzer},
    db::{DatabaseHandler, LatestDeviceEventState},
    types::activities::{ActivityType, SearchActivityPeriods},
};
use btwearable_codec::{
    WearablePacket,
    constants::{MetadataType, PacketType, WEARABLE_SERVICE},
};
use btwearable_entities::packets;
use chrono::{DateTime, Local, NaiveDateTime, NaiveTime, TimeDelta, Utc};
use clap::{CommandFactory, Parser, Subcommand};
use clap_complete::{Shell, generate};
use dotenv::dotenv;
use tokio::time::sleep;

#[cfg(target_os = "linux")]
pub type DeviceId = BDAddr;

#[cfg(target_os = "macos")]
pub type DeviceId = String;

#[derive(Parser)]
pub struct BtWearableCli {
    #[arg(env, long)]
    pub debug_packets: bool,
    #[arg(env, long)]
    pub database_url: String,
    #[cfg(target_os = "linux")]
    #[arg(env, long)]
    pub ble_interface: Option<String>,
    #[clap(subcommand)]
    pub subcommand: BtWearableCommand,
}

#[derive(Subcommand)]
pub enum BtWearableCommand {
    ///
    /// Scan for Wearable devices
    ///
    Scan,
    ///
    /// Download history data from wearable devices
    ///
    DownloadHistory {
        #[arg(long, env)]
        wearable: DeviceId,
        #[arg(
            long,
            help = "Experimental: rewind the device history cursor before downloading. Accepts decimal or 0x-prefixed hex."
        )]
        from_pointer: Option<String>,
    },
    ///
    /// Reruns the packet processing on stored packets
    /// This is used after new more of packets get handled
    ///
    ReRun,
    ///
    /// Detects sleeps and exercises
    ///
    DetectEvents,
    ///
    /// Print sleep statistics for all time and last week
    ///
    SleepStats,
    ///
    /// Print activity statistics for all time and last week
    ///
    ExerciseStats,
    ///
    /// Calculate stress for historical data
    ///
    CalculateStress,
    ///
    /// Calculate SpO2 from raw sensor data
    ///
    CalculateSpo2,
    ///
    /// Calculate skin temperature from raw sensor data
    ///
    CalculateSkinTemp,
    ///
    /// Show the latest computed skin temperature from local history
    ///
    SkinTemp,
    ///
    /// Recompute sleeps, activities, and derived health metrics from local history
    ///
    #[command(visible_alias = "refresh")]
    RefreshMetrics,
    ///
    /// Set alarm
    ///
    SetAlarm {
        #[arg(long, env)]
        wearable: DeviceId,
        alarm_time: AlarmTime,
    },
    ///
    /// Stream realtime heart rate
    ///
    StreamHr {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Stream live device events and logs
    ///
    StreamEvents {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    /// Get current alarm setting from device
    ///
    GetAlarm {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Read the device advertising name
    ///
    GetName {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Set the device advertising name
    ///
    #[command(visible_alias = "rename")]
    SetName {
        #[arg(long, env)]
        wearable: DeviceId,
        name: String,
    },
    ///
    /// Get current battery telemetry from device
    ///
    Battery {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Show the last charging event recorded in local packet history
    ///
    #[command(visible_alias = "charging")]
    ChargingStatus {
        #[arg(long, env)]
        wearable: Option<DeviceId>,
    },
    ///
    /// Get current body placement/contact status from device
    ///
    BodyStatus {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Get extended battery telemetry payload from device
    ///
    ExtendedBattery {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Query the raw history read-pointer range reported by the device
    ///
    GetDataRange {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Probe battery packets for reverse engineering
    ///
    ProbeBattery {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Send an arbitrary command packet and dump returned notifications
    ///
    ProbeCommand {
        #[arg(long, env)]
        wearable: DeviceId,
        command: String,
        #[arg(default_value = "")]
        payload_hex: String,
        #[arg(long, default_value_t = 3000)]
        listen_ms: u64,
        #[arg(long, default_value_t = false)]
        with_response: bool,
    },
    ///
    /// Start a history transfer but intentionally do not ACK chunk boundaries
    ///
    PeekHistory {
        #[arg(long, env)]
        wearable: DeviceId,
        #[arg(
            long,
            help = "Experimental: rewind the device history cursor before peeking. Accepts decimal or 0x-prefixed hex."
        )]
        from_pointer: Option<String>,
        #[arg(long, default_value_t = 10)]
        listen_secs: u64,
        #[arg(long, default_value_t = false)]
        sync_db: bool,
        #[arg(long, default_value_t = false)]
        refresh_metrics: bool,
    },
    ///
    /// Copy packets from one database into another
    ///
    Merge { from: String },
    Restart {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Erase all history data from the device
    ///
    Erase {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Get device firmware version info
    ///
    Version {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Generate Shell completions
    ///
    Completions { shell: Shell },
    ///
    /// Enable IMU data
    ///
    EnableImu {
        #[arg(long, env)]
        wearable: DeviceId,
    },
    ///
    /// Sync data between local and remote database
    ///
    Sync {
        #[arg(long, env)]
        remote: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if let Err(error) = dotenv() {
        println!("{}", error);
    }

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .filter_module("sqlx::query", log::LevelFilter::Off)
        .filter_module("sea_orm_migration::migrator", log::LevelFilter::Off)
        .filter_module("bluez_async", log::LevelFilter::Off)
        .filter_module("sqlx::postgres::notice", log::LevelFilter::Off)
        .init();

    BtWearableCli::parse().run().await
}

async fn scan_command(
    adapter: &Adapter,
    device_id: Option<DeviceId>,
) -> anyhow::Result<Peripheral> {
    adapter
        .start_scan(ScanFilter {
            services: vec![WEARABLE_SERVICE],
        })
        .await?;

    loop {
        let peripherals = adapter.peripherals().await?;

        for peripheral in peripherals {
            let Some(properties) = peripheral.properties().await? else {
                continue;
            };

            if !properties.services.contains(&WEARABLE_SERVICE) {
                continue;
            }

            let Some(device_id) = device_id.as_ref() else {
                println!("Address: {}", properties.address);
                #[cfg(target_os = "macos")]
                match properties.local_name.as_deref() {
                    Some(name) => {
                        let sanitized = sanitize_name(name);
                        if sanitized != name {
                            println!("Name: {:?} (sanitized: {:?})", name, sanitized);
                        } else {
                            println!("Name: {:?}", properties.local_name);
                        }
                    }
                    None => println!("Name: {:?}", properties.local_name),
                }
                #[cfg(not(target_os = "macos"))]
                println!("Name: {:?}", properties.local_name);
                println!("RSSI: {:?}", properties.rssi);
                println!();
                continue;
            };

            #[cfg(target_os = "linux")]
            if properties.address == *device_id {
                return Ok(peripheral);
            }

            #[cfg(target_os = "macos")]
            {
                let Some(name) = properties.local_name else {
                    continue;
                };
                if matches_device_name(&name, device_id) {
                    return Ok(peripheral);
                }
            }
        }

        sleep(Duration::from_secs(1)).await;
    }
}

#[derive(Clone, Copy, Debug)]
pub enum AlarmTime {
    DateTime(NaiveDateTime),
    Time(NaiveTime),
    Minute,
    Minute5,
    Minute10,
    Minute15,
    Minute30,
    Hour,
}

impl FromStr for AlarmTime {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if let Ok(t) = s.parse() {
            return Ok(Self::DateTime(t));
        }

        if let Ok(t) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
            return Ok(Self::DateTime(t));
        }

        if let Ok(t) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
            return Ok(Self::DateTime(t));
        }

        if let Ok(t) = s.parse() {
            return Ok(Self::Time(t));
        }

        match s {
            "minute" | "1min" | "min" => Ok(Self::Minute),
            "5minute" | "5min" => Ok(Self::Minute5),
            "10minute" | "10min" => Ok(Self::Minute10),
            "15minute" | "15min" => Ok(Self::Minute15),
            "30minute" | "30min" => Ok(Self::Minute30),
            "hour" | "h" => Ok(Self::Hour),
            _ => Err(anyhow!("Invalid alarm time")),
        }
    }
}

impl AlarmTime {
    pub fn unix(self) -> DateTime<Utc> {
        let mut now = Utc::now();
        let timezone_df = Local::now().offset().to_owned();

        match self {
            AlarmTime::DateTime(dt) => dt.and_utc() - timezone_df,
            AlarmTime::Time(t) => {
                let current_time = now.time();
                if current_time > t {
                    now += TimeDelta::days(1);
                }

                now.with_time(t).unwrap() - timezone_df
            }
            _ => {
                let offset = self.offset();
                now + offset
            }
        }
    }

    fn offset(self) -> TimeDelta {
        match self {
            AlarmTime::DateTime(_) => todo!(),
            AlarmTime::Time(_) => todo!(),
            AlarmTime::Minute => TimeDelta::minutes(1),
            AlarmTime::Minute5 => TimeDelta::minutes(5),
            AlarmTime::Minute10 => TimeDelta::minutes(10),
            AlarmTime::Minute15 => TimeDelta::minutes(15),
            AlarmTime::Minute30 => TimeDelta::minutes(30),
            AlarmTime::Hour => TimeDelta::hours(1),
        }
    }
}

#[cfg(target_os = "macos")]
pub fn sanitize_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(target_os = "macos")]
fn matches_device_name(scanned_name: &str, device_id: &str) -> bool {
    let sanitized = sanitize_name(scanned_name);
    if sanitized.starts_with(device_id) {
        return true;
    }

    let Some((_, suffix)) = sanitized.rsplit_once('[') else {
        return false;
    };
    let suffix = suffix.trim_end_matches(']').trim();
    suffix == device_id
}

impl BtWearableCli {
    async fn run(self) -> anyhow::Result<()> {
        let db_handler = DatabaseHandler::new(self.database_url.clone()).await;

        if matches!(
            self.subcommand,
            BtWearableCommand::ChargingStatus { wearable: _ }
        ) {
            let history = db_handler.get_latest_charging_status().await?;
            print_latest_device_state("Last charging event", history.charging);
            return Ok(());
        }

        if matches!(self.subcommand, BtWearableCommand::SkinTemp) {
            let wearable = BtWearable::new(db_handler.clone());
            wearable.calculate_skin_temp().await?;

            match db_handler.latest_skin_temp().await? {
                Some(reading) => {
                    if let Some(raw) = reading.skin_temp_raw {
                        println!(
                            "Skin temp: {:.2} C at {} (raw={raw})",
                            reading.temp_celsius, reading.time
                        );
                    } else {
                        println!(
                            "Skin temp: {:.2} C at {}",
                            reading.temp_celsius, reading.time
                        );
                    }
                }
                None => {
                    println!(
                        "No computed skin temperature found. Run `cargo run -- download-history --wearable <name>` or `cargo run -- refresh-metrics` after collecting more sensor data."
                    );
                }
            }
            return Ok(());
        }

        if matches!(self.subcommand, BtWearableCommand::RefreshMetrics) {
            let wearable = BtWearable::new(db_handler);
            wearable.refresh_metrics().await?;
            return Ok(());
        }

        if matches!(self.subcommand, BtWearableCommand::DetectEvents) {
            let wearable = BtWearable::new(db_handler);
            wearable.detect_sleeps().await?;
            wearable.detect_events().await?;
            wearable.database.recalculate_sleep_scores().await?;
            return Ok(());
        }

        let adapter = self.create_ble_adapter().await?;

        match self.subcommand {
            BtWearableCommand::Scan => {
                scan_command(&adapter, None).await?;
            }
            BtWearableCommand::DownloadHistory {
                wearable,
                from_pointer,
            } => {
                info!("Scanning for wearable to start history download");
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable =
                    WearableDevice::new(peripheral, adapter, db_handler, self.debug_packets);
                let replay_pointer = from_pointer.as_deref().map(parse_u32_arg).transpose()?;

                let should_exit = Arc::new(AtomicBool::new(false));

                let se = should_exit.clone();
                ctrlc::set_handler(move || {
                    println!("Received CTRL+C!");
                    se.store(true, Ordering::SeqCst);
                })?;

                info!("Connecting to wearable");
                wearable.connect().await?;
                info!("Initializing wearable session");
                wearable.initialize().await?;

                if let Some(pointer) = replay_pointer {
                    info!("Starting history replay from pointer {pointer} (0x{pointer:08x})");
                } else {
                    info!("Starting history sync");
                }
                let result = match replay_pointer {
                    Some(pointer) => {
                        wearable
                            .sync_history_from_pointer(pointer, should_exit)
                            .await
                    }
                    None => wearable.sync_history(should_exit).await,
                };

                info!("History sync loop exited");
                if let Err(e) = result {
                    error!("{}", e);
                }

                info!("Cleaning up high frequency sync state");
                let cleanup_deadline = Instant::now() + Duration::from_secs(10);
                loop {
                    if let Ok(true) = wearable.is_connected().await {
                        info!("Wearable still connected, sending exit_high_freq_sync");
                        wearable
                            .send_command(WearablePacket::exit_high_freq_sync())
                            .await?;
                        info!("History download cleanup complete");
                        break;
                    }

                    if Instant::now() >= cleanup_deadline {
                        warn!(
                            "Timed out trying to reconnect for exit_high_freq_sync; leaving cleanup early"
                        );
                        break;
                    }

                    info!("Wearable not connected after history sync, retrying reconnect");
                    if let Err(error) = wearable.connect().await {
                        warn!("Reconnect during history cleanup failed: {error}");
                    }
                    sleep(Duration::from_secs(1)).await;
                }

                info!("Running local metric refresh after history sync");
                wearable.refresh_metrics().await?;
            }
            BtWearableCommand::ReRun => {
                let mut wearable = BtWearable::new(db_handler.clone());
                let mut id = 0;
                loop {
                    let packets = db_handler.get_packets(id).await?;
                    if packets.is_empty() {
                        break;
                    }

                    for packet in packets {
                        id = packet.id;
                        wearable.handle_packet(packet).await?;
                    }

                    println!("{}", id);
                }
            }
            BtWearableCommand::DetectEvents => {
                let wearable = BtWearable::new(db_handler);
                wearable.detect_sleeps().await?;
                wearable.detect_events().await?;
                wearable.database.recalculate_sleep_scores().await?;
            }
            BtWearableCommand::SleepStats => {
                let wearable = BtWearable::new(db_handler);
                let sleep_records = wearable.database.get_sleep_cycles(None).await?;

                if sleep_records.is_empty() {
                    println!("No sleep records found, exiting now");
                    return Ok(());
                }

                let mut last_week = sleep_records
                    .iter()
                    .rev()
                    .take(7)
                    .copied()
                    .collect::<Vec<_>>();

                last_week.reverse();
                let analyzer = SleepConsistencyAnalyzer::new(sleep_records);
                let metrics = analyzer.calculate_consistency_metrics()?;
                println!("All time: \n{}", metrics);
                let analyzer = SleepConsistencyAnalyzer::new(last_week);
                let metrics = analyzer.calculate_consistency_metrics()?;
                println!("\nWeek: \n{}", metrics);
            }
            BtWearableCommand::ExerciseStats => {
                let wearable = BtWearable::new(db_handler);
                let exercises = wearable
                    .database
                    .search_activities(
                        SearchActivityPeriods::default().with_activity(ActivityType::Activity),
                    )
                    .await?;

                if exercises.is_empty() {
                    println!("No activities found, exiting now");
                    return Ok(());
                };

                let last_week = exercises
                    .iter()
                    .rev()
                    .take(7)
                    .copied()
                    .rev()
                    .collect::<Vec<_>>();

                let metrics = ExerciseMetrics::new(exercises)?;
                let last_week = ExerciseMetrics::new(last_week)?;

                println!("All time: \n{}", metrics);
                println!("Last week: \n{}", last_week);
            }
            BtWearableCommand::CalculateStress => {
                let wearable = BtWearable::new(db_handler);
                wearable.calculate_stress().await?;
            }
            BtWearableCommand::CalculateSpo2 => {
                let wearable = BtWearable::new(db_handler);
                wearable.calculate_spo2().await?;
            }
            BtWearableCommand::CalculateSkinTemp => {
                let wearable = BtWearable::new(db_handler);
                wearable.calculate_skin_temp().await?;
            }
            BtWearableCommand::SkinTemp => {
                let wearable = BtWearable::new(db_handler.clone());
                wearable.calculate_skin_temp().await?;
                match db_handler.latest_skin_temp().await? {
                    Some(reading) => {
                        if let Some(raw) = reading.skin_temp_raw {
                            println!(
                                "Skin temp: {:.2} C at {} (raw={raw})",
                                reading.temp_celsius, reading.time
                            );
                        } else {
                            println!(
                                "Skin temp: {:.2} C at {}",
                                reading.temp_celsius, reading.time
                            );
                        }
                    }
                    None => {
                        println!(
                            "No computed skin temperature found. Run `cargo run -- download-history --wearable <name>` or `cargo run -- refresh-metrics` after collecting more sensor data."
                        );
                    }
                }
            }
            BtWearableCommand::RefreshMetrics => {
                let wearable = BtWearable::new(db_handler);
                wearable.refresh_metrics().await?;
            }
            BtWearableCommand::SetAlarm {
                wearable,
                alarm_time,
            } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable =
                    WearableDevice::new(peripheral, adapter, db_handler, self.debug_packets);
                wearable.connect().await?;

                let time = alarm_time.unix();
                let now = Utc::now();

                if time < now {
                    error!(
                        "Time {} is in past, current time: {}",
                        time.format("%Y-%m-%d %H:%M:%S"),
                        now.format("%Y-%m-%d %H:%M:%S")
                    );
                    return Ok(());
                }

                let packet = WearablePacket::alarm_time(u32::try_from(time.timestamp())?);
                wearable.send_command(packet).await?;
                let time = time.with_timezone(&Local);

                println!("Alarm time set for: {}", time.format("%Y-%m-%d %H:%M:%S"));
            }
            BtWearableCommand::StreamHr { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable =
                    WearableDevice::new(peripheral, adapter, db_handler, self.debug_packets);
                let should_exit = Arc::new(AtomicBool::new(false));
                let se = should_exit.clone();
                ctrlc::set_handler(move || {
                    se.store(true, Ordering::SeqCst);
                })?;
                wearable.connect().await?;
                wearable.stream_hr(should_exit).await?;
            }
            BtWearableCommand::StreamEvents { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                let should_exit = Arc::new(AtomicBool::new(false));
                let se = should_exit.clone();
                ctrlc::set_handler(move || {
                    se.store(true, Ordering::SeqCst);
                })?;
                wearable.connect().await?;
                wearable.stream_events(should_exit).await?;
            }
            BtWearableCommand::GetAlarm { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                let data = wearable.get_alarm().await?;
                if let btwearable_codec::WearableData::AlarmInfo { enabled, unix } = data {
                    if enabled {
                        let alarm_time = DateTime::from_timestamp(i64::from(unix), 0)
                            .ok_or_else(|| anyhow!("Invalid alarm timestamp"))?
                            .with_timezone(&Local);
                        println!(
                            "Alarm is set for: {}",
                            alarm_time.format("%Y-%m-%d %H:%M:%S")
                        );
                    } else {
                        println!("No alarm is currently set");
                    }
                } else {
                    error!("Unexpected response from device: {:?}", data);
                }
            }
            BtWearableCommand::GetName { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                let name = wearable.get_name().await?;
                println!("Advertising name: {name}");
            }
            BtWearableCommand::SetName { wearable, name } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                let reported_name = wearable.set_name(&name).await?;
                println!("Advertising name set to: {reported_name}");
                #[cfg(target_os = "macos")]
                println!("Update WEARABLE in .env to the new name before the next scan.");
            }
            BtWearableCommand::Battery { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                print_command_response("Battery", wearable.get_battery().await?);
            }
            BtWearableCommand::ChargingStatus { wearable: _ } => {
                let history = db_handler.get_latest_charging_status().await?;
                print_latest_device_state("Last charging event", history.charging);
            }
            BtWearableCommand::BodyStatus { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                print_command_response("Body status", wearable.get_body_status().await?);
            }
            BtWearableCommand::ExtendedBattery { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                print_command_response(
                    "Extended battery",
                    wearable.get_extended_battery_info().await?,
                );
            }
            BtWearableCommand::GetDataRange { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                wearable.initialize().await?;
                let data_range = wearable.get_data_range().await;
                if let Ok(true) = wearable.is_connected().await {
                    let _ = wearable
                        .send_command(WearablePacket::exit_high_freq_sync())
                        .await;
                }
                print_command_response("History data range", data_range?);
            }
            BtWearableCommand::ProbeBattery { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                print_battery_probe(wearable.probe_battery().await?);
            }
            BtWearableCommand::ProbeCommand {
                wearable,
                command,
                payload_hex,
                listen_ms,
                with_response,
            } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;

                let command = parse_u8_arg(&command)?;
                let payload = parse_hex_payload(&payload_hex)?;
                let packet = WearablePacket::new(PacketType::Command, 0, command, payload);
                let entries = wearable
                    .probe_command(packet, with_response, Duration::from_millis(listen_ms))
                    .await?;
                print_command_probe(command, &entries);
            }
            BtWearableCommand::PeekHistory {
                wearable,
                from_pointer,
                listen_secs,
                sync_db,
                refresh_metrics,
            } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                let replay_pointer = from_pointer.as_deref().map(parse_u32_arg).transpose()?;
                let sync_db = sync_db || refresh_metrics;
                wearable.connect().await?;
                wearable.initialize().await?;
                let summary = wearable
                    .peek_history(
                        replay_pointer,
                        Duration::from_secs(listen_secs),
                        sync_db,
                        refresh_metrics,
                    )
                    .await?;
                if let Ok(true) = wearable.is_connected().await {
                    let _ = wearable
                        .send_command(WearablePacket::exit_high_freq_sync())
                        .await;
                }
                print_history_peek_summary(&summary);
            }
            BtWearableCommand::Merge { from } => {
                let from_db = DatabaseHandler::new(from).await;

                let mut id = 0;
                loop {
                    let packets = from_db.get_packets(id).await?;
                    if packets.is_empty() {
                        break;
                    }

                    for packets::Model {
                        uuid,
                        bytes,
                        id: c_id,
                    } in packets
                    {
                        id = c_id;
                        db_handler.create_packet(uuid, bytes).await?;
                    }

                    println!("{}", id);
                }
            }
            BtWearableCommand::Restart { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable =
                    WearableDevice::new(peripheral, adapter, db_handler, self.debug_packets);
                wearable.connect().await?;
                wearable.send_command(WearablePacket::restart()).await?;
            }
            BtWearableCommand::Erase { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable =
                    WearableDevice::new(peripheral, adapter, db_handler, self.debug_packets);
                wearable.connect().await?;
                wearable.send_command(WearablePacket::erase()).await?;
                info!("Erase command sent - device will trim all stored history data");
            }
            BtWearableCommand::Version { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                wearable.get_version().await?;
            }
            BtWearableCommand::EnableImu { wearable } => {
                let peripheral = scan_command(&adapter, Some(wearable)).await?;
                let mut wearable = WearableDevice::new(peripheral, adapter, db_handler, false);
                wearable.connect().await?;
                wearable
                    .send_command(WearablePacket::toggle_r7_data_collection())
                    .await?;
            }
            BtWearableCommand::Sync { remote } => {
                let remote_db = DatabaseHandler::new(remote).await;
                let sync = btwearable::db::sync::DatabaseSync::new(
                    db_handler.connection(),
                    remote_db.connection(),
                );
                sync.run().await?;
            }
            BtWearableCommand::Completions { shell } => {
                let mut command = BtWearableCli::command();
                let bin_name = command.get_name().to_string();
                generate(shell, &mut command, bin_name, &mut io::stdout());
            }
        }

        Ok(())
    }

    async fn create_ble_adapter(&self) -> anyhow::Result<Adapter> {
        let manager = Manager::new().await?;

        #[cfg(target_os = "linux")]
        match self.ble_interface.as_ref() {
            Some(interface) => Self::adapter_from_name(&manager, interface).await,
            None => Self::default_adapter(&manager).await,
        }

        #[cfg(target_os = "macos")]
        Self::default_adapter(&manager).await
    }

    #[cfg(target_os = "linux")]
    async fn adapter_from_name(manager: &Manager, interface: &str) -> anyhow::Result<Adapter> {
        let adapters = manager.adapters().await?;
        let mut c_adapter = Err(anyhow!("Adapter: `{}` not found", interface));
        for adapter in adapters {
            let name = adapter.adapter_info().await?;
            if name.starts_with(interface) {
                c_adapter = Ok(adapter);
                break;
            }
        }

        c_adapter
    }

    async fn default_adapter(manager: &Manager) -> anyhow::Result<Adapter> {
        let adapters = manager.adapters().await?;
        adapters
            .into_iter()
            .next()
            .ok_or(anyhow!("No BLE adapters found"))
    }
}

fn print_command_response(label: &str, data: btwearable_codec::WearableData) {
    match data {
        btwearable_codec::WearableData::DeviceEvent {
            unix,
            event,
            payload,
        } => match event {
            btwearable_codec::constants::EventNumber::BatteryLevel => {
                if let Some(decoded) = decode_battery_event_payload(&payload) {
                    let charge = format_tenths_percent(decoded.charge_tenths_percent);
                    println!(
                        "{label}: {charge} ({event:?}, inferred 0.1% units) at {} sample_ticks={} body_len={} kind=0x{:02x} charge_raw={} main_mv={} state=0x{:04x} secondary_mv={} flags=0x{:04x} payload={}",
                        format_local_timestamp(unix),
                        decoded.sample_ticks,
                        decoded.body_len,
                        decoded.kind,
                        decoded.charge_tenths_percent,
                        decoded.main_mv,
                        decoded.state_word,
                        decoded.secondary_mv,
                        decoded.flags,
                        hex::encode(payload)
                    );
                } else {
                    println!(
                        "{label}: {:?} at {} payload={}",
                        event,
                        format_local_timestamp(unix),
                        hex::encode(payload)
                    );
                }
            }
            btwearable_codec::constants::EventNumber::ExtendedBatteryInformation => {
                if let Some(decoded) = decode_extended_battery_event_payload(&payload) {
                    println!(
                        "{label}: field1={} field2={} main_mv={} field3={} field4={} field5={} secondary_mv={} flags=0x{:04x} field6={} at {} sample_ticks={} body_len={} kind=0x{:02x} payload={}",
                        decoded.field_1,
                        decoded.field_2,
                        decoded.main_mv,
                        decoded.field_3,
                        decoded.field_4,
                        decoded.field_5,
                        decoded.secondary_mv,
                        decoded.flags,
                        decoded.field_6,
                        format_local_timestamp(unix),
                        decoded.sample_ticks,
                        decoded.body_len,
                        decoded.kind,
                        hex::encode(payload)
                    );
                } else {
                    println!(
                        "{label}: {:?} at {} payload={}",
                        event,
                        format_local_timestamp(unix),
                        hex::encode(payload)
                    );
                }
            }
            _ => {
                println!(
                    "{label}: {:?} at {} payload={}",
                    event,
                    format_local_timestamp(unix),
                    hex::encode(payload)
                );
            }
        },
        btwearable_codec::WearableData::RawCommandResponse { command, payload } => match command {
            btwearable_codec::constants::CommandNumber::GetBatteryLevel => {
                match decode_battery_response_payload(&payload) {
                    Some(raw_tenths_percent) => {
                        let charge = format_tenths_percent(raw_tenths_percent);
                        println!(
                            "{label}: {charge} (raw=0x{raw_tenths_percent:04x}/{raw_tenths_percent}, inferred 0.1% units), payload={}",
                            hex::encode(payload),
                        );
                    }
                    None => println!("{label} ({command:?}): {}", hex::encode(payload)),
                }
            }
            btwearable_codec::constants::CommandNumber::GetBodyLocationAndStatus => {
                let status = payload.get(2).copied().unwrap_or_default();
                let status_label = match status {
                    0 => "off-body/unknown",
                    1 => "on-body",
                    _ => "unknown",
                };
                println!(
                    "{label}: {status_label} (status=0x{status:02x}, payload={})",
                    hex::encode(payload)
                );
            }
            btwearable_codec::constants::CommandNumber::GetExtendedBatteryInfo => {
                match decode_extended_battery_response_payload(&payload) {
                    Some(decoded) => {
                        println!(
                            "{label}: field1={} field2={} main_mv={} field3={} field4={} field5={} secondary_mv={} flags=0x{:04x} field6={} payload={}",
                            decoded.field_1,
                            decoded.field_2,
                            decoded.main_mv,
                            decoded.field_3,
                            decoded.field_4,
                            decoded.field_5,
                            decoded.secondary_mv,
                            decoded.flags,
                            decoded.field_6,
                            hex::encode(payload)
                        );
                    }
                    None => println!("{label} ({command:?}): {}", hex::encode(payload)),
                }
            }
            btwearable_codec::constants::CommandNumber::GetDataRange => {
                let entries = decode_data_range_entries(&payload);
                if entries.is_empty() {
                    let words = decode_u32_words(&payload);
                    if words.is_empty() {
                        println!("{label} ({command:?}): {}", hex::encode(payload));
                    } else {
                        let decoded_words = words
                            .iter()
                            .enumerate()
                            .map(|(index, word)| format!("w{index}=0x{word:08x}/{word}"))
                            .collect::<Vec<_>>()
                            .join(", ");
                        println!(
                            "{label}: payload={} decoded_words=[{}]",
                            hex::encode(payload),
                            decoded_words
                        );
                    }
                } else {
                    let formatted_entries = entries
                        .iter()
                        .map(|entry| {
                            format!(
                                "off={} time={} pointer=0x{:08x}/{}",
                                entry.offset,
                                format_local_timestamp(entry.unix),
                                entry.pointer,
                                entry.pointer
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    println!(
                        "{label}: payload={} entries=[{}]",
                        hex::encode(payload),
                        formatted_entries
                    );
                }
            }
            _ => {
                println!("{label} ({command:?}): {}", hex::encode(payload));
            }
        },
        other => println!("{label}: {other:?}"),
    }
}

fn print_battery_probe(probe: BatteryProbeResult) {
    println!("Battery probe:");

    if let Some(response) = probe.battery_response {
        print_command_response("  short response", response);
    } else {
        println!("  short response: <missing>");
    }

    if let Some(response) = probe.extended_battery_response {
        print_command_response("  extended response", response);
    } else {
        println!("  extended response: <missing>");
    }

    if let Some(battery_event) = probe.battery_event {
        print_battery_device_event("  battery event", battery_event);
    } else {
        println!("  battery event: <missing>");
    }

    if let Some(extended_event) = probe.extended_battery_event {
        print_extended_battery_device_event("  extended event", extended_event);
    } else {
        println!("  extended event: <missing>");
    }
}

fn print_command_probe(command: u8, entries: &[CommandProbeEntry]) {
    let command_name = btwearable_codec::constants::CommandNumber::from_u8(command)
        .map(|command| format!("{command:?}"))
        .unwrap_or_else(|| "unknown".to_string());
    println!("Command probe for 0x{command:02x} ({command_name})");

    if entries.is_empty() {
        println!("  no notifications received");
        return;
    }

    for entry in entries {
        let packet_type = entry
            .packet_type
            .map(|packet_type| format!("{packet_type:?}"))
            .unwrap_or_else(|| "raw".to_string());
        let cmd = entry
            .cmd
            .map(|cmd| format!("0x{cmd:02x}"))
            .unwrap_or_else(|| "--".to_string());
        let decoded = entry.decoded.as_deref().unwrap_or("no decode");

        println!(
            "  uuid={} type={} cmd={} payload={} decoded={}",
            entry.uuid,
            packet_type,
            cmd,
            hex::encode(&entry.payload),
            decoded
        );
    }
}

fn print_history_peek_summary(summary: &HistoryPeekSummary) {
    println!(
        "History peek: notifications={} decoded={} readings={} first={} last={} history_end={} history_complete={} timed_out={} stream_ended={} sync_db={} refresh_metrics={} trailing_flushes={}",
        summary.notifications,
        summary.decoded_packets,
        summary.readings,
        summary
            .first_reading_unix
            .and_then(format_history_reading_time)
            .unwrap_or_else(|| "-".to_string()),
        summary
            .last_reading_unix
            .and_then(format_history_reading_time)
            .unwrap_or_else(|| "-".to_string()),
        summary.history_end_seen,
        summary.history_complete_seen,
        summary.timed_out,
        summary.stream_ended,
        summary.synced_to_db,
        summary.refreshed_metrics,
        summary.trailing_history_flushes
    );

    if summary.metadata.is_empty() {
        println!("  metadata: <none>");
        return;
    }

    let metadata = summary
        .metadata
        .iter()
        .map(|entry| {
            let label = match entry.cmd {
                MetadataType::HistoryStart => "HistoryStart",
                MetadataType::HistoryEnd => "HistoryEnd",
                MetadataType::HistoryComplete => "HistoryComplete",
            };
            format!(
                "{label}@{} data=0x{:08x}/{}",
                format_local_timestamp(entry.unix),
                entry.data,
                entry.data
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    println!("  metadata: {metadata}");
}

fn print_battery_device_event(label: &str, data: btwearable_codec::WearableData) {
    let btwearable_codec::WearableData::DeviceEvent { unix, payload, .. } = data else {
        println!("{label}: {data:?}");
        return;
    };

    let Some(decoded) = decode_battery_event_payload(&payload) else {
        println!(
            "{label}: undecoded at {} payload={}",
            format_local_timestamp(unix),
            hex::encode(payload)
        );
        return;
    };

    println!(
        "{label}: {} (inferred 0.1% units) at {} sample_ticks={} body_len={} kind=0x{:02x} charge_raw={} main_mv={} state=0x{:04x} secondary_mv={} flags=0x{:04x} payload={}",
        format_tenths_percent(decoded.charge_tenths_percent),
        format_local_timestamp(unix),
        decoded.sample_ticks,
        decoded.body_len,
        decoded.kind,
        decoded.charge_tenths_percent,
        decoded.main_mv,
        decoded.state_word,
        decoded.secondary_mv,
        decoded.flags,
        hex::encode(payload)
    );
}

fn print_extended_battery_device_event(label: &str, data: btwearable_codec::WearableData) {
    let btwearable_codec::WearableData::DeviceEvent { unix, payload, .. } = data else {
        println!("{label}: {data:?}");
        return;
    };

    let Some(decoded) = decode_extended_battery_event_payload(&payload) else {
        println!(
            "{label}: undecoded at {} payload={}",
            format_local_timestamp(unix),
            hex::encode(payload)
        );
        return;
    };

    println!(
        "{label}: at {} sample_ticks={} body_len={} kind=0x{:02x} field1={} field2={} main_mv={} field3={} field4={} field5={} secondary_mv={} flags=0x{:04x} field6={} payload={}",
        format_local_timestamp(unix),
        decoded.sample_ticks,
        decoded.body_len,
        decoded.kind,
        decoded.field_1,
        decoded.field_2,
        decoded.main_mv,
        decoded.field_3,
        decoded.field_4,
        decoded.field_5,
        decoded.secondary_mv,
        decoded.flags,
        decoded.field_6,
        hex::encode(payload)
    );
}

fn format_local_timestamp(unix: u32) -> String {
    DateTime::from_timestamp(i64::from(unix), 0)
        .map(|t| {
            t.with_timezone(&Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| unix.to_string())
}

fn format_history_reading_time(unix_ms: u64) -> Option<String> {
    let unix_ms = i64::try_from(unix_ms).ok()?;
    DateTime::from_timestamp_millis(unix_ms).map(|time| {
        time.with_timezone(&Local)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    })
}

fn parse_u8_arg(value: &str) -> anyhow::Result<u8> {
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return Ok(u8::from_str_radix(hex, 16)?);
    }

    match value.parse::<u8>() {
        Ok(value) => Ok(value),
        Err(decimal_error) => u8::from_str_radix(value, 16).map_err(|hex_error| {
            anyhow!("invalid command `{value}`: {decimal_error}; {hex_error}")
        }),
    }
}

fn parse_u32_arg(value: &str) -> anyhow::Result<u32> {
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return Ok(u32::from_str_radix(hex, 16)?);
    }

    match value.parse::<u32>() {
        Ok(value) => Ok(value),
        Err(decimal_error) => u32::from_str_radix(value, 16).map_err(|hex_error| {
            anyhow!("invalid pointer `{value}`: {decimal_error}; {hex_error}")
        }),
    }
}

fn parse_hex_payload(value: &str) -> anyhow::Result<Vec<u8>> {
    let normalized = value
        .chars()
        .filter(|character| !character.is_ascii_whitespace() && *character != '_')
        .collect::<String>();

    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    let normalized = normalized
        .strip_prefix("0x")
        .or_else(|| normalized.strip_prefix("0X"))
        .unwrap_or(&normalized);

    if normalized.len() % 2 != 0 {
        return Err(anyhow!("hex payload must contain an even number of digits"));
    }

    Ok(hex::decode(normalized)?)
}

#[derive(Debug, Clone, Copy)]
struct BatteryEventDecoded {
    sample_ticks: u16,
    body_len: u16,
    kind: u8,
    charge_tenths_percent: u16,
    main_mv: u16,
    state_word: u16,
    secondary_mv: u16,
    flags: u16,
}

fn decode_battery_event_payload(payload: &[u8]) -> Option<BatteryEventDecoded> {
    if payload.len() < 24 {
        return None;
    }

    let sample_ticks = read_u16_le(payload, 0)?;
    let body_len = read_u16_le(payload, 2)?;
    let body = payload.get(4..)?;
    if usize::from(body_len) != body.len() || body.len() < 20 {
        return None;
    }

    Some(BatteryEventDecoded {
        sample_ticks,
        body_len,
        kind: *body.first()?,
        charge_tenths_percent: read_u16_le(body, 1)?,
        main_mv: read_u16_le(body, 5)?,
        state_word: read_u16_le(body, 9)?,
        secondary_mv: read_u16_le(body, 11)?,
        flags: read_u16_le(body, 15)?,
    })
}

#[derive(Debug, Clone, Copy)]
struct ExtendedBatteryEventDecoded {
    sample_ticks: u16,
    body_len: u16,
    kind: u8,
    field_1: i16,
    field_2: i16,
    main_mv: u16,
    field_3: u16,
    field_4: u16,
    field_5: u16,
    secondary_mv: u16,
    flags: u16,
    field_6: u16,
}

fn decode_extended_battery_event_payload(payload: &[u8]) -> Option<ExtendedBatteryEventDecoded> {
    if payload.len() < 32 {
        return None;
    }

    let sample_ticks = read_u16_le(payload, 0)?;
    let body_len = read_u16_le(payload, 2)?;
    let body = payload.get(4..)?;
    if usize::from(body_len) != body.len() || body.len() < 28 {
        return None;
    }

    let mut decoded = decode_extended_battery_words(body.get(1..)?)?;
    decoded.sample_ticks = sample_ticks;
    decoded.body_len = body_len;
    decoded.kind = *body.first()?;
    Some(decoded)
}

fn decode_extended_battery_response_payload(payload: &[u8]) -> Option<ExtendedBatteryEventDecoded> {
    if payload.len() < 29 {
        return None;
    }

    decode_extended_battery_words(payload.get(3..)?)
}

fn decode_extended_battery_words(words: &[u8]) -> Option<ExtendedBatteryEventDecoded> {
    if words.len() < 26 {
        return None;
    }

    Some(ExtendedBatteryEventDecoded {
        sample_ticks: 0,
        body_len: 0,
        kind: 0,
        field_1: read_i16_le(words, 0)?,
        field_2: read_i16_le(words, 2)?,
        main_mv: read_u16_le(words, 4)?,
        field_3: read_u16_le(words, 6)?,
        field_4: read_u16_le(words, 10)?,
        field_5: read_u16_le(words, 12)?,
        secondary_mv: read_u16_le(words, 14)?,
        flags: read_u16_le(words, 18)?,
        field_6: read_u16_le(words, 22)?,
    })
}

fn print_latest_device_state(label: &str, state: Option<LatestDeviceEventState>) {
    match state {
        Some(state) => {
            let status = if state.active { "on" } else { "off" };
            println!(
                "{label}: {status} via {:?} at {} (packet #{})",
                state.event,
                format_local_timestamp(state.unix),
                state.packet_id,
            );
        }
        None => println!("{label}: unknown"),
    }
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    let bytes = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let bytes = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn decode_u32_words(payload: &[u8]) -> Vec<u32> {
    let mut words = Vec::new();
    let mut offset = 0;
    while let Some(word) = read_u32_le(payload, offset) {
        words.push(word);
        offset += 4;
    }
    words
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DataRangeEntry {
    offset: usize,
    unix: u32,
    pointer: u32,
}

fn decode_data_range_entries(payload: &[u8]) -> Vec<DataRangeEntry> {
    const MIN_PLAUSIBLE_UNIX: u32 = 1_577_836_800; // 2020-01-01T00:00:00Z

    let max_plausible_unix = Utc::now()
        .checked_add_signed(TimeDelta::days(366))
        .and_then(|time| u32::try_from(time.timestamp()).ok())
        .unwrap_or(u32::MAX);

    let compact_entries =
        decode_data_range_entries_in_window(payload, MIN_PLAUSIBLE_UNIX, max_plausible_unix, true);
    if !compact_entries.is_empty() {
        return compact_entries;
    }

    decode_data_range_entries_in_window(payload, MIN_PLAUSIBLE_UNIX, max_plausible_unix, false)
}

fn decode_data_range_entries_in_window(
    payload: &[u8],
    min_plausible_unix: u32,
    max_plausible_unix: u32,
    require_zero_upper_pointer_bytes: bool,
) -> Vec<DataRangeEntry> {
    const MAX_PLAUSIBLE_POINTER: u32 = 0x00ff_ffff;

    let mut entries = Vec::new();
    let mut offset = 0;

    while offset + 8 <= payload.len() {
        let Some(unix) = read_u32_le(payload, offset) else {
            break;
        };
        let Some(pointer) = read_u32_le(payload, offset + 4) else {
            break;
        };

        let has_zero_upper_pointer_bytes = payload
            .get(offset + 6..offset + 8)
            .map(|tail| tail == [0x00, 0x00])
            .unwrap_or(false);

        if (min_plausible_unix..=max_plausible_unix).contains(&unix)
            && (1..=MAX_PLAUSIBLE_POINTER).contains(&pointer)
            && (!require_zero_upper_pointer_bytes || has_zero_upper_pointer_bytes)
        {
            entries.push(DataRangeEntry {
                offset,
                unix,
                pointer,
            });
            offset += 8;
        } else {
            offset += 1;
        }
    }

    entries
}

fn read_i16_le(bytes: &[u8], offset: usize) -> Option<i16> {
    let bytes = bytes.get(offset..offset + 2)?;
    Some(i16::from_le_bytes([bytes[0], bytes[1]]))
}

fn decode_battery_response_payload(payload: &[u8]) -> Option<u16> {
    read_u16_le(payload, 2)
}

fn format_tenths_percent(tenths_percent: u16) -> String {
    format!("{}.{}%", tenths_percent / 10, tenths_percent % 10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_data_range_entries_extracts_timestamp_pointer_pairs() {
        let payload = hex::decode(
            "00010140cc000007cc00002bcc000007cc00001c000000000002006801000098fe13000ab98469086300000d6ace69f04000000d6ace69f04000005d6bce69b87b00000000",
        )
        .unwrap();

        assert_eq!(
            decode_data_range_entries_in_window(&payload, 1_577_836_800, 1_900_000_000, true),
            vec![
                DataRangeEntry {
                    offset: 35,
                    unix: 0x6984b90a,
                    pointer: 0x00006308,
                },
                DataRangeEntry {
                    offset: 43,
                    unix: 0x69ce6a0d,
                    pointer: 0x000040f0,
                },
                DataRangeEntry {
                    offset: 51,
                    unix: 0x69ce6a0d,
                    pointer: 0x000040f0,
                },
                DataRangeEntry {
                    offset: 59,
                    unix: 0x69ce6b5d,
                    pointer: 0x00007bb8,
                },
            ]
        );
    }
}
