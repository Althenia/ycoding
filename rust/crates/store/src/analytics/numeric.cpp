#include "duckdb.h"
#include "duckdb/common/exception.hpp"
#include "duckdb/function/aggregate_function.hpp"
#include "duckdb/function/aggregate_state.hpp"
#include "duckdb/main/connection.hpp"
#include "duckdb/storage/arena_allocator.hpp"
#include "duckdb/storage/buffer_manager.hpp"
#include "duckdb/storage/buffer/temporary_file_information.hpp"
#include <cstddef>
#include <cstdint>
#include <limits>
#include <new>

namespace duckdb {
AggregateFunction &GetCAggregateFunction(duckdb_aggregate_function function);
void CAPIAggregateUpdate(Vector inputs[], AggregateInputData &data, idx_t input_count,
                         Vector &states, idx_t count);
void CAPIAggregateCombine(Vector &source, Vector &target, AggregateInputData &data, idx_t count);
void CAPIAggregateFinalize(Vector &states, AggregateInputData &data, Vector &result,
                           idx_t count, idx_t offset);
}

struct YCodingDecimalState {
    uint32_t *words;
    uint32_t length;
    uint32_t capacity;
    int32_t scale;
    uint32_t flags;
};

static_assert(sizeof(YCodingDecimalState) >= 24 && sizeof(YCodingDecimalState) <= 32,
              "Decimal aggregate state must remain compact");

struct YCodingArenaAllocation {
    void *data;
    uint32_t status;
    uint32_t reserved;
};

struct YCodingNativeObservation {
    uint64_t memory;
    uint64_t temporary;
    uint32_t status;
    uint32_t reserved;
};

namespace {
enum ArenaStatus : uint32_t {
    ArenaOk = 0,
    ArenaUnavailable = 1,
    ArenaSizeOverflow = 2,
    ArenaOutOfMemory = 3,
    ArenaFailure = 4
};

thread_local duckdb::ArenaAllocator *active_arena = nullptr;
using Probe = void (*)(void *, uint32_t);
thread_local Probe probe = nullptr;
thread_local void *probe_context = nullptr;

class ArenaScope {
public:
    explicit ArenaScope(duckdb::ArenaAllocator &arena) noexcept : previous(active_arena) {
        active_arena = &arena;
    }
    ~ArenaScope() noexcept {
        active_arena = previous;
    }
    ArenaScope(const ArenaScope &) = delete;
    ArenaScope &operator=(const ArenaScope &) = delete;
private:
    duckdb::ArenaAllocator *previous;
};

void Notify(uint32_t event) {
    if (probe) {
        probe(probe_context, event);
    }
}

void ArenaUpdate(duckdb::Vector inputs[], duckdb::AggregateInputData &data,
                 duckdb::idx_t input_count, duckdb::Vector &states, duckdb::idx_t count) {
    ArenaScope scope(data.allocator);
    states.Flatten(count);
    duckdb::CAPIAggregateUpdate(inputs, data, input_count, states, count);
    Notify(1);
}

void ArenaCombine(duckdb::Vector &source, duckdb::Vector &target,
                  duckdb::AggregateInputData &data, duckdb::idx_t count) {
    ArenaScope scope(data.allocator);
    source.Flatten(count);
    target.Flatten(count);
    duckdb::CAPIAggregateCombine(source, target, data, count);
    Notify(2);
}

void ArenaFinalize(duckdb::Vector &states, duckdb::AggregateInputData &data,
                   duckdb::Vector &result, duckdb::idx_t count, duckdb::idx_t offset) {
    ArenaScope scope(data.allocator);
    duckdb::CAPIAggregateFinalize(states, data, result, count, offset);
    Notify(3);
}
}

extern "C" duckdb::idx_t ycoding_decimal_state_size(duckdb_function_info) noexcept {
    return sizeof(YCodingDecimalState);
}

extern "C" void ycoding_decimal_state_init(duckdb_function_info,
                                           duckdb_aggregate_state state) noexcept {
    ::new (static_cast<void *>(state)) YCodingDecimalState{nullptr, 0, 0, 0, 0};
}

extern "C" void ycoding_decimal_state_destroy(duckdb_aggregate_state *states,
                                              duckdb::idx_t count) noexcept {
    for (duckdb::idx_t index = 0; index < count; ++index) {
        auto state = reinterpret_cast<YCodingDecimalState *>(states[index]);
        *state = YCodingDecimalState{nullptr, 0, 0, 0, 0};
    }
}

extern "C" YCodingArenaAllocation ycoding_decimal_arena_allocate(uint64_t bytes) noexcept {
    if (!active_arena) {
        return {nullptr, ArenaUnavailable, 0};
    }
    if (bytes == 0) {
        return {nullptr, ArenaOk, 0};
    }
    if (bytes > std::numeric_limits<duckdb::idx_t>::max() - 7) {
        return {nullptr, ArenaSizeOverflow, 0};
    }
    try {
        auto head = active_arena->GetHead();
        if (head && head->current_position > std::numeric_limits<duckdb::idx_t>::max() - 7 - bytes) {
            return {nullptr, ArenaSizeOverflow, 0};
        }
        return {active_arena->AllocateAligned(static_cast<duckdb::idx_t>(bytes)), ArenaOk, 0};
    } catch (const duckdb::OutOfMemoryException &) {
        return {nullptr, ArenaOutOfMemory, 0};
    } catch (...) {
        return {nullptr, ArenaFailure, 0};
    }
}

extern "C" uint32_t ycoding_decimal_install_arena(duckdb_aggregate_function handle) noexcept {
    if (!handle) {
        return ArenaUnavailable;
    }
    try {
        auto &function = duckdb::GetCAggregateFunction(handle);
        if (function.GetStateUpdateCallback() != duckdb::CAPIAggregateUpdate ||
            function.GetStateCombineCallback() != duckdb::CAPIAggregateCombine ||
            function.GetStateFinalizeCallback() != duckdb::CAPIAggregateFinalize ||
            function.GetStateSimpleUpdateCallback() != nullptr) {
            return ArenaFailure;
        }
        duckdb_aggregate_function_set_destructor(handle, ycoding_decimal_state_destroy);
        function.update = ArenaUpdate;
        function.combine = ArenaCombine;
        function.finalize = ArenaFinalize;
        return ArenaOk;
    } catch (...) {
        return ArenaFailure;
    }
}

extern "C" uint32_t ycoding_decimal_output_prepare(duckdb_vector vector) noexcept {
    try {
        duckdb_vector_ensure_validity_writable(vector);
        return ArenaOk;
    } catch (...) {
        return ArenaFailure;
    }
}

extern "C" uint32_t ycoding_decimal_output_assign(duckdb_vector vector, uint64_t row,
                                                  const char *data, uint64_t length) noexcept {
    try {
        duckdb_vector_assign_string_element_len(vector, row, data, length);
        return ArenaOk;
    } catch (...) {
        return ArenaFailure;
    }
}

extern "C" void ycoding_decimal_probe_set(Probe callback, void *context) noexcept {
    probe = callback;
    probe_context = context;
}

extern "C" YCodingNativeObservation ycoding_decimal_probe_observe(duckdb_connection raw) noexcept {
    try {
        auto &connection = *reinterpret_cast<duckdb::Connection *>(raw);
        auto &manager = duckdb::BufferManager::GetBufferManager(*connection.context);
        uint64_t temporary = 0;
        for (auto &file : manager.GetTemporaryFiles()) {
            temporary += file.size;
        }
        return {manager.GetUsedMemory(), temporary, ArenaOk, 0};
    } catch (...) {
        return {0, 0, ArenaFailure, 0};
    }
}

extern "C" uint32_t ycoding_decimal_probe_scope(duckdb_connection raw,
                                                uint32_t (*callback)(void *), void *context) noexcept {
    try {
        auto &connection = *reinterpret_cast<duckdb::Connection *>(raw);
        duckdb::ArenaAllocator arena(duckdb::BufferAllocator::Get(*connection.context));
        ArenaScope scope(arena);
        return callback(context);
    } catch (const duckdb::OutOfMemoryException &) {
        return ArenaOutOfMemory;
    } catch (...) {
        return ArenaFailure;
    }
}

extern "C" uint64_t ycoding_decimal_probe_layout(uint32_t field) noexcept {
    switch (field) {
    case 0: return sizeof(YCodingDecimalState);
    case 1: return alignof(YCodingDecimalState);
    case 2: return offsetof(YCodingDecimalState, words);
    case 3: return offsetof(YCodingDecimalState, length);
    case 4: return offsetof(YCodingDecimalState, capacity);
    case 5: return offsetof(YCodingDecimalState, scale);
    case 6: return offsetof(YCodingDecimalState, flags);
    case 7: return sizeof(YCodingArenaAllocation);
    case 8: return alignof(YCodingArenaAllocation);
    default: return std::numeric_limits<uint64_t>::max();
    }
}
