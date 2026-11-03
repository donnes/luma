//! Fire TV and Android TV. Luma runs as SDL's `libmain.so` inside the APK's
//! `app.luma.firetv.MainActivity` (an SDLActivity). The activity passes the
//! command line, and answers the platform worker's inventory, launch and
//! settings requests through JNI; everything else is the desktop build.
use crate::platform::{Request, Response};
use jni::{
    JNIEnv,
    objects::{JByteArray, JObject, JString, JValue},
};
use serde_json::Value;
use std::{
    ffi::{CStr, CString, c_char, c_int, c_void},
    io::{BufRead, BufReader},
    os::fd::FromRawFd,
};

/// The id `Target::TvSettings` launches, webOS's Settings app; here it opens Fire TV Settings.
const TV_SETTINGS_ID: &str = "com.palm.app.settings";

unsafe extern "C" {
    fn SDL_AndroidGetJNIEnv() -> *mut c_void;
    fn SDL_AndroidGetActivity() -> *mut c_void;
    fn __android_log_write(priority: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

/// SDLActivity's entry point, called on its own thread with `getArguments()` after argv[0].
#[unsafe(no_mangle)]
pub extern "C" fn SDL_main(argc: c_int, argv: *mut *mut c_char) -> c_int {
    log_output();
    // Back reaches Luma as AC_BACK, which owns the Back stack, instead of finishing the activity.
    sdl2::hint::set("SDL_ANDROID_TRAP_BACK_BUTTON", "1");
    let args = (0..usize::try_from(argc).unwrap_or(0)).map(|index| {
        // SAFETY: SDL passes argc valid, NUL-terminated strings.
        unsafe { CStr::from_ptr(*argv.add(index)) }
            .to_string_lossy()
            .into_owned()
    });
    match crate::run(args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Luma native: {error}");
            1
        }
    }
}

/// Android drops a native library's stdout and stderr; send Luma's diagnostics to logcat.
fn log_output() {
    let mut fds = [0; 2];
    // SAFETY: plain pipe/dup2 on descriptors this function owns.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    unsafe {
        libc::dup2(fds[1], libc::STDOUT_FILENO);
        libc::dup2(fds[1], libc::STDERR_FILENO);
        libc::close(fds[1]);
    }
    // SAFETY: the read end is ours alone from here on.
    let reader = BufReader::new(unsafe { std::fs::File::from_raw_fd(fds[0]) });
    std::thread::spawn(move || {
        let tag = c"luma";
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(text) = CString::new(line) {
                // SAFETY: both strings are NUL-terminated and outlive the call. 4 is ANDROID_LOG_INFO.
                unsafe { __android_log_write(4, tag.as_ptr(), text.as_ptr()) };
            }
        }
    });
}

/// The platform worker's requests that Android answers; the rest go back to the shared worker.
pub fn handle(request: Request) -> Result<Response, Request> {
    Ok(match request {
        Request::Refresh => Response::Inventory(inventory().map(|inventory| (inventory, None))),
        Request::RefreshInputs => Response::Inputs(Ok(vec![])),
        Request::Launch(id) if id == TV_SETTINGS_ID => {
            Response::Launched(call("openSettings", None).map(|_| ()))
        }
        Request::Launch(id) => Response::Launched(call("launchApp", Some(&id)).and_then(|reply| {
            let reply: Value = serde_json::from_str(&reply).map_err(|error| error.to_string())?;
            match reply.get("error").and_then(Value::as_str) {
                Some(error) => Err(error.to_owned()),
                None => Ok(()),
            }
        })),
        Request::Uninstall(id) => Response::Uninstalled {
            id,
            result: Err("Uninstall apps from Fire TV Settings.".into()),
        },
        Request::Recent {
            generation,
            command,
        } => {
            // Fire OS keeps no recents Luma can read; List answers with an empty row.
            let entries = (command == crate::recents::Command::List).then(Vec::new);
            Response::Recent {
                generation,
                command,
                result: Ok(entries),
            }
        }
        other => return Err(other),
    })
}

fn inventory() -> Result<crate::model::Inventory, String> {
    let reply: Value =
        serde_json::from_str(&call("listApps", None)?).map_err(|error| error.to_string())?;
    let apps = reply
        .get("apps")
        .and_then(Value::as_array)
        .ok_or("Invalid app inventory")?
        .iter()
        .filter(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(streaming)
        })
        .cloned()
        .collect();
    Ok(crate::model::Inventory {
        apps: crate::platform::normalize_apps(&Value::Array(apps))?,
        inputs: vec![],
    })
}

/// Fire OS lists its own tools and Amazon storefronts as launchable apps. The library
/// keeps the streaming apps: every third-party app plus Amazon's Prime Video and YouTube.
fn streaming(id: &str) -> bool {
    matches!(
        id,
        "com.amazon.firebat" | "com.amazon.avod" | "com.amazon.firetv.youtube"
    ) || !["com.amazon.", "amazon.", "com.android."]
        .iter()
        .any(|prefix| id.starts_with(prefix))
}

/// The app's TV banner or icon as PNG, drawn by the shell; None when it ships neither.
pub fn app_art(id: &str) -> Option<Vec<u8>> {
    // SAFETY: as in `call`.
    let mut env = unsafe { JNIEnv::from_raw(SDL_AndroidGetJNIEnv().cast()) }.ok()?;
    let art = env.with_local_frame(8, |env| -> Result<Option<Vec<u8>>, jni::errors::Error> {
        // SAFETY: as in `call`.
        let activity = unsafe { JObject::from_raw(SDL_AndroidGetActivity().cast()) };
        let id = env.new_string(id)?;
        let png = env
            .call_method(
                &activity,
                "appArt",
                "(Ljava/lang/String;)[B",
                &[JValue::Object(&id)],
            )?
            .l()?;
        if png.is_null() {
            return Ok(None);
        }
        Ok(Some(env.convert_byte_array(JByteArray::from(png))?))
    });
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    art.unwrap_or_else(|error| {
        eprintln!("Luma app art {id}: {error}");
        None
    })
}

/// Calls a `String method()` or `String method(String)` on the activity from any thread.
fn call(method: &str, argument: Option<&str>) -> Result<String, String> {
    // SAFETY: SDL attaches the calling thread to the VM and returns its JNIEnv.
    let mut env = unsafe { JNIEnv::from_raw(SDL_AndroidGetJNIEnv().cast()) }
        .map_err(|error| error.to_string())?;
    let result = env.with_local_frame(8, |env| -> Result<String, jni::errors::Error> {
        // SAFETY: SDL returns a new local reference to its activity, freed with this frame.
        let activity = unsafe { JObject::from_raw(SDL_AndroidGetActivity().cast()) };
        let value = match argument {
            None => env.call_method(&activity, method, "()Ljava/lang/String;", &[])?,
            Some(argument) => {
                let argument = env.new_string(argument)?;
                env.call_method(
                    &activity,
                    method,
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(&argument)],
                )?
            }
        };
        let text = JString::from(value.l()?);
        Ok(env.get_string(&text)?.into())
    });
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result.map_err(|error| format!("{method} failed: {error}"))
}
