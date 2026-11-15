# Aggregate server memory diagnostics

## Added

- Servers started with `YCODING_LOG_LEVEL=DEBUG` record separate current and lifetime-peak RSS measurements in the existing private log. Node also reports current heap size, capacity and external memory.
- Sampling stops after 120 records at 30-second intervals or when the server scope closes. Normal Info-level operation does not sample memory.
- Unsupported, unavailable and failed measurements have explicit statuses rather than numeric substitutes. Bun heap sampling remains unavailable with an unverified basis. Diagnostics do not collect heap snapshots, run forced GC or infer native allocation retention.
