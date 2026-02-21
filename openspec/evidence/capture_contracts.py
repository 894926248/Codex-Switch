import json
import pathlib
import re


ROOT = pathlib.Path(__file__).resolve().parents[2]
RUST_ROOT = ROOT / "src-tauri" / "src"
TS_ROOT = ROOT / "src"
EVIDENCE_ROOT = ROOT / "openspec" / "evidence"


def extract_rust_commands() -> list[str]:
    names: set[str] = set()
    for path in RUST_ROOT.rglob("*.rs"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        lines = text.splitlines()
        for idx, line in enumerate(lines):
            if "#[tauri::command]" not in line:
                continue
            for next_idx in range(idx + 1, min(idx + 8, len(lines))):
                match = re.search(r"fn\s+(\w+)", lines[next_idx])
                if match:
                    names.add(match.group(1))
                    break
    return sorted(names)


def extract_ts_invokes() -> list[str]:
    names: set[str] = set()
    invoke_pattern = re.compile(r"invoke\(\s*['\"]([A-Za-z0-9_]+)['\"]")
    for path in TS_ROOT.rglob("*"):
        if path.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        names.update(invoke_pattern.findall(text))
    return sorted(names)


def main() -> None:
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)

    rust_commands = extract_rust_commands()
    ts_invokes = extract_ts_invokes()

    _ = (EVIDENCE_ROOT / "contract-rust-current.txt").write_text(
        "\n".join(rust_commands) + "\n",
        encoding="utf-8",
    )
    _ = (EVIDENCE_ROOT / "contract-ts-current.txt").write_text(
        "\n".join(ts_invokes) + "\n",
        encoding="utf-8",
    )
    _ = (EVIDENCE_ROOT / "contract-summary.json").write_text(
        json.dumps(
            {
                "rust_command_count": len(rust_commands),
                "ts_invoke_count": len(ts_invokes),
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )

    print(f"rust_command_count={len(rust_commands)}")
    print(f"ts_invoke_count={len(ts_invokes)}")


if __name__ == "__main__":
    main()
