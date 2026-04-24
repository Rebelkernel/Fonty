use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FontyError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("font parse error: {0}")]
    Parse(#[from] ttf_parser::FaceParsingError),
    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("font has no usable family name")]
    NoFamilyName,
    #[error("{0}")]
    Msg(String),
}

impl Serialize for FontyError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, FontyError>;
