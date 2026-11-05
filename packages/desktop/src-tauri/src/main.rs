#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;

fn main() {
    host::run();
}
