use crate::error::WearableError;

type Result<T> = std::result::Result<T, InvalidIndexError>;

#[derive(Debug)]
pub struct InvalidIndexError;

pub trait BufferReader {
    fn read<const N: usize>(&mut self) -> Result<[u8; N]>;
    fn read_end<const N: usize>(&mut self) -> Result<[u8; N]>;
    fn pop_front(&mut self) -> Result<u8>;

    fn read_u32_le(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.read()?))
    }
    fn read_u16_le(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.read()?))
    }
}

impl BufferReader for Vec<u8> {
    fn read<const N: usize>(&mut self) -> Result<[u8; N]> {
        if self.len() < N {
            return Err(InvalidIndexError);
        }

        self.drain(0..N)
            .collect::<Vec<u8>>()
            .try_into()
            .map_err(|_| InvalidIndexError)
    }

    fn read_end<const N: usize>(&mut self) -> Result<[u8; N]> {
        let size = self.len();
        if size < N {
            return Err(InvalidIndexError);
        }

        self.drain((size - N)..size)
            .collect::<Vec<u8>>()
            .try_into()
            .map_err(|_| InvalidIndexError)
    }

    fn pop_front(&mut self) -> Result<u8> {
        if !self.is_empty() {
            Ok(self.remove(0))
        } else {
            Err(InvalidIndexError)
        }
    }
}

impl From<InvalidIndexError> for WearableError {
    fn from(_: InvalidIndexError) -> Self {
        Self::InvalidIndexError
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_extracts_from_front() {
        let mut buf = vec![0x01, 0x02, 0x03, 0x04];
        let result: [u8; 2] = buf.read().unwrap();
        assert_eq!(result, [0x01, 0x02]);
        assert_eq!(buf, vec![0x03, 0x04]);
    }

    #[test]
    fn read_insufficient_data_errors() {
        let mut buf = vec![0x01];
        let result: Result<[u8; 4]> = buf.read();
        assert!(result.is_err());
    }

    #[test]
    fn read_end_extracts_from_back() {
        let mut buf = vec![0x01, 0x02, 0x03, 0x04];
        let result: [u8; 2] = buf.read_end().unwrap();
        assert_eq!(result, [0x03, 0x04]);
        assert_eq!(buf, vec![0x01, 0x02]);
    }

    #[test]
    fn read_end_insufficient_data_errors() {
        let mut buf = vec![0x01];
        let result: Result<[u8; 4]> = buf.read_end();
        assert!(result.is_err());
    }

    #[test]
    fn pop_front_returns_first_byte() {
        let mut buf = vec![0xAA, 0xBB];
        assert_eq!(buf.pop_front().unwrap(), 0xAA);
        assert_eq!(buf, vec![0xBB]);
    }

    #[test]
    fn pop_front_empty_errors() {
        let mut buf: Vec<u8> = vec![];
        assert!(buf.pop_front().is_err());
    }

    #[test]
    fn read_u32_le_parses_correctly() {
        let mut buf = vec![0x04, 0x03, 0x02, 0x01, 0xFF];
        let val = buf.read_u32_le().unwrap();
        assert_eq!(val, 0x01020304);
        assert_eq!(buf, vec![0xFF]);
    }

    #[test]
    fn read_u16_le_parses_correctly() {
        let mut buf = vec![0x34, 0x12, 0xFF];
        let val = buf.read_u16_le().unwrap();
        assert_eq!(val, 0x1234);
        assert_eq!(buf, vec![0xFF]);
    }
}
