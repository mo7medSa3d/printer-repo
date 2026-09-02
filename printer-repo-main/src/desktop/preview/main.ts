/**
 * Browser preview entry — installs the fake Tauri backend, then boots the
 * real desktop application unchanged. Development only; never bundled.
 */
import "./mock-tauri";
import "../main";
