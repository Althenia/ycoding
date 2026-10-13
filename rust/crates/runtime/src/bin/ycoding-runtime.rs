use std::process::ExitCode;
use ycoding_runtime::launch::{
    EXIT_FAILURE, EXIT_OK, EXIT_USAGE, LaunchError, Mode, Parsed, USAGE, parse_launch,
    record_startup_error, run,
};

fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let parsed = match parse_launch(&args, |name| std::env::var(name).ok()) {
        Ok(parsed) => parsed,
        Err(error @ LaunchError::Usage(_)) => {
            eprintln!("{error}\n\n{USAGE}");
            return ExitCode::from(EXIT_USAGE);
        }
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(EXIT_FAILURE);
        }
    };
    match parsed {
        Parsed::Help => {
            print!("{USAGE}");
            ExitCode::from(EXIT_OK)
        }
        Parsed::Version(version) => {
            println!("ycoding-runtime {version}");
            ExitCode::from(EXIT_OK)
        }
        Parsed::Run(config) => {
            if config.mode == Mode::Stdio {
                unsafe {
                    std::env::remove_var("YCODING_PASSWORD");
                    std::env::remove_var("YCODING_SERVER_PASSWORD");
                }
            }
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    record_startup_error(&config, &LaunchError::Io(error));
                    eprintln!("failed to create the runtime");
                    return ExitCode::from(EXIT_FAILURE);
                }
            };
            match runtime.block_on(run((*config).clone())) {
                Ok(()) => ExitCode::from(EXIT_OK),
                Err(error) => {
                    record_startup_error(&config, &error);
                    eprintln!("{error}");
                    ExitCode::from(EXIT_FAILURE)
                }
            }
        }
        Parsed::Paths(paths) => {
            println!("{paths}");
            ExitCode::from(EXIT_OK)
        }
    }
}
