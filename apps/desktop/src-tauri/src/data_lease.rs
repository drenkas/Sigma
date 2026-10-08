use std::{
    fs::{File, OpenOptions},
    io,
    os::unix::{fs::{MetadataExt, OpenOptionsExt, PermissionsExt}, io::AsRawFd, process::CommandExt},
    path::Path,
    process::Command,
};

pub struct DataLease { directory: File, file: File }

fn descriptor(path: &Path, directory: bool) -> io::Result<File> {
    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: i32 = 0x100;
    #[cfg(target_os = "linux")]
    const O_NOFOLLOW: i32 = 0x20000;
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(O_NOFOLLOW);
    if !directory { options.create(true).write(true).mode(0o600); }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    let named = std::fs::symlink_metadata(path)?;
    let valid = |info: &std::fs::Metadata| if directory { info.is_dir() } else { info.is_file() && info.nlink() == 1 };
    if !valid(&opened) || !valid(&named) || opened.dev() != named.dev() || opened.ino() != named.ino() {
        return Err(io::Error::other("Invalid DATA_DIR lease identity"));
    }
    unsafe extern "C" { fn flock(fd: i32, operation: i32) -> i32; }
    if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "DATA_DIR is already owned by another Sigma process"));
        }
        return Err(error);
    }
    let current = std::fs::symlink_metadata(path)?;
    if !valid(&current) || current.dev() != opened.dev() || current.ino() != opened.ino() {
        return Err(io::Error::other("DATA_DIR lease identity changed"));
    }
    file.set_permissions(std::fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }))?;
    Ok(file)
}

pub fn instance_lock(path: &Path) -> io::Result<DataLease> {
    std::fs::create_dir_all(path)?;
    let path = path.canonicalize()?;
    // Stable directory first; the legacy file lock keeps old native owners
    // mutually exclusive even if they do not yet lock the directory.
    let directory = descriptor(&path, true)?;
    let file = descriptor(&path.join("sigma.lock"), false)?;
    Ok(DataLease { directory, file })
}

pub fn inherit_lock(command: &mut Command, lock: &DataLease) {
    let fds = [lock.directory.as_raw_fd(), lock.file.as_raw_fd()];
    command.env("SIGMA_DATA_DIR_LOCK_FD", fds[0].to_string()).env("SIGMA_DATA_LOCK_FD", fds[1].to_string());
    unsafe {
        command.pre_exec(move || {
            unsafe extern "C" { fn fcntl(fd: i32, command: i32, ...) -> i32; }
            const F_GETFD: i32 = 1;
            const F_SETFD: i32 = 2;
            const FD_CLOEXEC: i32 = 1;
            for fd in fds {
                let flags = fcntl(fd, F_GETFD);
                if flags < 0 || fcntl(fd, F_SETFD, flags & !FD_CLOEXEC) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
}
