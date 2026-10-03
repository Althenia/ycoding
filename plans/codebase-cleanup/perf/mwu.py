import argparse
import json
import math
import statistics


def samples(path: str, key: str) -> list[float]:
    value = json.load(open(path))
    for part in key.split("."):
        value = value[int(part)] if isinstance(value, list) else value[part]
    if not isinstance(value, list) or not value or not all(isinstance(item, (int, float)) for item in value):
        raise SystemExit(f"{path}:{key} is not a nonempty numeric array")
    return [float(item) for item in value]


def mann_whitney(before: list[float], after: list[float]) -> tuple[float, float]:
    combined = sorted([(value, 0) for value in before] + [(value, 1) for value in after])
    ranks = [0.0] * len(combined)
    ties = 0.0
    index = 0
    while index < len(combined):
        end = index
        while end + 1 < len(combined) and combined[end + 1][0] == combined[index][0]:
            end += 1
        for position in range(index, end + 1):
            ranks[position] = (index + end) / 2 + 1
        count = end - index + 1
        ties += count**3 - count
        index = end + 1
    n1 = len(before)
    n2 = len(after)
    rank_sum = sum(rank for rank, (_, group) in zip(ranks, combined) if group == 0)
    u1 = rank_sum - n1 * (n1 + 1) / 2
    u = min(u1, n1 * n2 - u1)
    n = n1 + n2
    variance = n1 * n2 / 12 * ((n + 1) - ties / (n * (n - 1)))
    if variance == 0:
        return u, 1.0
    z = (abs(u1 - n1 * n2 / 2) - 0.5) / math.sqrt(variance)
    return u, math.erfc(max(z, 0) / math.sqrt(2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Two-sided Mann-Whitney U (normal approximation, tie and continuity corrected)")
    parser.add_argument("before")
    parser.add_argument("after")
    parser.add_argument("--key", required=True, help="dotted path to the sample array, e.g. results.0.times or raw")
    parser.add_argument("--after-key", help="sample path in the after file when it differs")
    args = parser.parse_args()
    before = samples(args.before, args.key)
    after = samples(args.after, args.after_key or args.key)
    u, p = mann_whitney(before, after)
    median_before = statistics.median(before)
    median_after = statistics.median(after)
    print(json.dumps({
        "nBefore": len(before),
        "nAfter": len(after),
        "medianBefore": median_before,
        "medianAfter": median_after,
        "deltaMedianPercent": (median_after - median_before) / median_before * 100,
        "u": u,
        "p": p,
        "significant": p < 0.05,
        "improvedAtLeast10Percent": median_after <= median_before * 0.9,
    }))


if __name__ == "__main__":
    main()
