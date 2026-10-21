#![cfg(unix)]

use super::{PtySession, PtySessionOptions};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const PAYLOAD_LINES: usize = 16_384;
const PAYLOAD_BYTES: usize = PAYLOAD_LINES * 64;

fn payload() -> Vec<u8> {
    format!("{}\n", "x".repeat(63)).repeat(PAYLOAD_LINES).into_bytes()
}

fn force_kill(pid: u32) {
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
}

#[test]
fn write_returns_while_the_child_is_not_reading_its_input() {
    let session = PtySession::start(PtySessionOptions::new("sleep").arg("30"), |_| {}).unwrap();
    let pid = session.pid().unwrap();
    let (returned_tx, returned_rx) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        let mut session = session;
        let result = session.write(&payload());
        returned_tx.send(()).unwrap();
        (session, result)
    });

    let returned = returned_rx.recv_timeout(Duration::from_secs(5)).is_ok();
    force_kill(pid);
    let (mut session, result) = writer.join().unwrap();

    assert!(
        returned,
        "PtySession::write blocked its caller while the child was not reading input"
    );
    result.unwrap();
    session.wait().unwrap();
}

#[test]
fn queued_input_reaches_the_child_once_it_starts_reading() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&output);
    let mut session = PtySession::start(
        PtySessionOptions::new("sh")
            .arg("-c")
            .arg(format!("stty -echo; sleep 1; head -c {PAYLOAD_BYTES} | wc -c")),
        move |chunk| seen.lock().unwrap().extend_from_slice(chunk),
    )
    .unwrap();

    session.write(&payload()).unwrap();
    let exit = session.wait().unwrap();

    assert_eq!(exit.exit_code, Some(0));
    let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
    let count = text.split_whitespace().last().unwrap_or_default().to_string();
    assert_eq!(count, PAYLOAD_BYTES.to_string(), "child output: {text:?}");
}

#[test]
fn write_after_exit_reports_a_closed_session() {
    let mut session = PtySession::start(PtySessionOptions::new("true"), |_| {}).unwrap();
    session.wait().unwrap();

    let error = session.write(b"late\n").unwrap_err();

    assert_eq!(error.to_string(), "pty session is closed");
}
