//! The jig binary doubles as a `jj resolve` merge tool: the editor builds the
//! resolved file content, and jj runs `jig --resolve-output <content> <output>`
//! to have it copied over the tool's `$output` file.

use std::fs;

use anyhow::{Context, Result};

/// Entry point for `jig --resolve-output <content-file> <output>`.
pub fn run(content: &str, output: &str) -> Result<()> {
    let bytes = fs::read(content).with_context(|| format!("read {content}"))?;
    fs::write(output, bytes).with_context(|| format!("write {output}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_content_bytes() {
        let dir = std::env::temp_dir().join(format!("jig-resolve-tool-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let content = dir.join("content");
        let output = dir.join("output");
        fs::write(&content, b"a\r\n\xff\nb").unwrap();
        fs::write(&output, b"old contents that are longer").unwrap();
        run(content.to_str().unwrap(), output.to_str().unwrap()).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"a\r\n\xff\nb");
        assert!(run(dir.join("missing").to_str().unwrap(), output.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
