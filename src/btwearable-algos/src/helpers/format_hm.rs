use chrono::{NaiveTime, TimeDelta, Timelike as _};

pub trait FormatHM {
    fn format_hm(&self) -> String;
}

impl FormatHM for TimeDelta {
    fn format_hm(&self) -> String {
        let total = self.num_seconds() as f64 / 60.0;
        total.format_hm()
    }
}

impl FormatHM for f64 {
    fn format_hm(&self) -> String {
        let minutes = self % 1440.0;
        let h = (minutes / 60.0) as i32;
        let m = (minutes % 60.0) as i32;
        format!("{:02}:{:02}", h, m)
    }
}

impl FormatHM for NaiveTime {
    fn format_hm(&self) -> String {
        format!("{:02}:{:02}", self.hour(), self.minute())
    }
}
