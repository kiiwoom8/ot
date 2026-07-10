#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Overtime recorder for monthly allowance management.

Storage
- SQLite database (one file)
- Efficient for monthly summaries, edits, and long-term history

What this tool does
- Records overtime by date/time
- Applies 1.5x base overtime by default
- Applies 2.0x for 22:00–06:00 night overtime overlap
- Adds per-hour allowance rules (example: 5,000 / 10,000 / 15,000 ...)
- Summarizes each month’s expected additional allowances

Why SQLite?
- One file, easy backup
- Fast month filtering and totals
- No need to rewrite a whole JSON file when one record changes

Notes
- Times are entered as HH:MM.
- If end time is earlier than start time, the shift is treated as crossing midnight.
- Special allowance rules are proration-based by minute overlap.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

try:
    import msvcrt  # type: ignore
except Exception:
    msvcrt = None


APP_DIR = Path(__file__).resolve().parent
DB_PATH = APP_DIR / "ot.sqlite3"


class GoBack(Exception):
    """Raised when the user presses ESC to cancel a prompt."""
    pass


def clear_screen() -> None:
    os.system("cls" if os.name == "nt" else "clear")


def get_single_key(prompt: str) -> str:
    """Prompt and return one key."""
    if msvcrt is None:
        return input(prompt).strip()[:1]
    sys.stdout.write(prompt)
    sys.stdout.flush()
    while True:
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):
            _ = msvcrt.getwch()
            continue
        sys.stdout.write(ch + "\n")
        sys.stdout.flush()
        return ch


def wait_any_key(message: str = "아무 키를 누르면 계속합니다...") -> None:
    if msvcrt is None:
        input(message)
        return
    sys.stdout.write(message)
    sys.stdout.flush()
    while True:
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):
            _ = msvcrt.getwch()
            continue
        sys.stdout.write("\n")
        sys.stdout.flush()
        return


def get_line(prompt: str, default: str | None = None) -> str | None:
    """Read a line, with ESC cancel support on Windows."""
    suffix = f" [{default}]" if default is not None else ""
    if msvcrt is None:
        return input(f"{prompt}{suffix}: ")

    sys.stdout.write(f"{prompt}{suffix}: ")
    sys.stdout.flush()
    buf: list[str] = []
    while True:
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):
            _ = msvcrt.getwch()
            continue
        if ch == "\x1b":
            sys.stdout.write("\n")
            sys.stdout.flush()
            return None
        if ch in ("\r", "\n"):
            sys.stdout.write("\n")
            sys.stdout.flush()
            return "".join(buf)
        if ch == "\x08":
            if buf:
                buf.pop()
                sys.stdout.write("\b \b")
                sys.stdout.flush()
            continue
        buf.append(ch)
        sys.stdout.write(ch)
        sys.stdout.flush()


def fmt_won(value: float) -> str:
    return f"{round(value):,}원"


def month_key(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def normalize_time_input(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("시간이 비어 있습니다.")
    if ":" in value:
        hh, mm = value.split(":", 1)
        h = int(hh)
        m = int(mm)
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError("시간 범위가 올바르지 않습니다.")
        return f"{h:02d}:{m:02d}"
    if value.isdigit():
        h = int(value)
        if not (0 <= h <= 23):
            raise ValueError("시간 범위가 올바르지 않습니다.")
        return f"{h:02d}:00"
    raise ValueError("시간 형식은 HH:MM 이어야 합니다.")


def parse_hhmm(value: str) -> int:
    """Return minutes from midnight."""
    value = normalize_time_input(value)
    hh, mm = value.split(":", 1)
    h = int(hh)
    m = int(mm)
    return h * 60 + m


def minutes_to_hhmm(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def interval_minutes(start_min: int, end_min: int) -> int:
    """Minutes worked, assuming end may cross midnight."""
    if end_min <= start_min:
        end_min += 24 * 60
    return end_min - start_min


def overlap_minutes(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def cross_midnight_segments(start_min: int, end_min: int) -> list[tuple[int, int]]:
    """
    Create one or two segments on a 48-hour axis for a window that may cross midnight.
    Returned segments are suitable for overlap testing against a shift interval.
    """
    if start_min < end_min:
        return [(start_min, end_min), (start_min + 1440, end_min + 1440)]
    return [(start_min, 1440), (1440, end_min + 1440)]


def overlap_with_window(shift_start: int, shift_end: int, window_start: int, window_end: int) -> int:
    """Return overlap minutes between a shift and a window that may cross midnight."""
    if shift_end <= shift_start:
        shift_end += 1440

    segments = cross_midnight_segments(window_start, window_end)
    total = 0
    for ws, we in segments:
        total += overlap_minutes(shift_start, shift_end, ws, we)
    return total


@dataclass
class MonthProfile:
    year: int
    month: int
    hourly_wage: float = 10320.0
    ot_multiplier: float = 1.5
    night_multiplier: float = 2.0
    night_start: str = "22:00"
    night_end: str = "06:00"
    note: str = ""


@dataclass
class AllowanceRule:
    id: int | None
    name: str
    start_time: str
    end_time: str
    amount_per_hour: float
    active: bool = True


@dataclass
class OTRecord:
    id: int | None
    year: int
    month: int
    work_date: str
    start_time: str
    end_time: str
    hours: float
    base_pay: float
    night_pay: float
    allowance_pay: float
    total_pay: float
    memo: str = ""


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS month_profiles (
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                hourly_wage REAL NOT NULL DEFAULT 10320,
                ot_multiplier REAL NOT NULL DEFAULT 1.5,
                night_multiplier REAL NOT NULL DEFAULT 2.0,
                night_start TEXT NOT NULL DEFAULT '22:00',
                night_end TEXT NOT NULL DEFAULT '06:00',
                note TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (year, month)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS allowance_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                amount_per_hour REAL NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ot_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                work_date TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                hours REAL NOT NULL,
                base_pay REAL NOT NULL,
                night_pay REAL NOT NULL,
                allowance_pay REAL NOT NULL,
                total_pay REAL NOT NULL,
                memo TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ot_records_month ON ot_records(year, month, work_date)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_allowance_rules_active ON allowance_rules(active)"
        )


def upsert_month_profile(profile: MonthProfile) -> None:
    with db_connect() as conn:
        conn.execute(
            """
            INSERT INTO month_profiles (
                year, month, hourly_wage, ot_multiplier, night_multiplier,
                night_start, night_end, note, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(year, month) DO UPDATE SET
                hourly_wage=excluded.hourly_wage,
                ot_multiplier=excluded.ot_multiplier,
                night_multiplier=excluded.night_multiplier,
                night_start=excluded.night_start,
                night_end=excluded.night_end,
                note=excluded.note,
                updated_at=CURRENT_TIMESTAMP
            """,
            (
                profile.year,
                profile.month,
                profile.hourly_wage,
                profile.ot_multiplier,
                profile.night_multiplier,
                profile.night_start,
                profile.night_end,
                profile.note,
            ),
        )


def get_month_profile(year: int, month: int) -> MonthProfile:
    with db_connect() as conn:
        row = conn.execute(
            "SELECT * FROM month_profiles WHERE year=? AND month=?",
            (year, month),
        ).fetchone()
    if row is None:
        return MonthProfile(year=year, month=month)
    return MonthProfile(
        year=row["year"],
        month=row["month"],
        hourly_wage=row["hourly_wage"],
        ot_multiplier=row["ot_multiplier"],
        night_multiplier=row["night_multiplier"],
        night_start=row["night_start"],
        night_end=row["night_end"],
        note=row["note"],
    )


def add_allowance_rule(rule: AllowanceRule) -> None:
    with db_connect() as conn:
        conn.execute(
            """
            INSERT INTO allowance_rules (name, start_time, end_time, amount_per_hour, active, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (rule.name, rule.start_time, rule.end_time, rule.amount_per_hour, 1 if rule.active else 0),
        )


def list_allowance_rules(active_only: bool = False) -> list[AllowanceRule]:
    with db_connect() as conn:
        if active_only:
            rows = conn.execute(
                "SELECT * FROM allowance_rules WHERE active=1 ORDER BY id"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM allowance_rules ORDER BY active DESC, id"
            ).fetchall()

    rules: list[AllowanceRule] = []
    for row in rows:
        rules.append(
            AllowanceRule(
                id=row["id"],
                name=row["name"],
                start_time=row["start_time"],
                end_time=row["end_time"],
                amount_per_hour=row["amount_per_hour"],
                active=bool(row["active"]),
            )
        )
    return rules


def delete_allowance_rule(rule_id: int) -> None:
    with db_connect() as conn:
        conn.execute("DELETE FROM allowance_rules WHERE id=?", (rule_id,))


def set_allowance_rule_active(rule_id: int, active: bool) -> None:
    with db_connect() as conn:
        conn.execute(
            "UPDATE allowance_rules SET active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (1 if active else 0, rule_id),
        )


def calculate_allowance_pay(start_min: int, end_min: int, rules: Sequence[AllowanceRule]) -> float:
    if end_min <= start_min:
        end_min += 1440

    total = 0.0
    for rule in rules:
        if not rule.active:
            continue
        rs = parse_hhmm(rule.start_time)
        re = parse_hhmm(rule.end_time)
        segments = cross_midnight_segments(rs, re)
        rule_minutes = 0
        for seg_start, seg_end in segments:
            rule_minutes += overlap_minutes(start_min, end_min, seg_start, seg_end)
        total += (rule_minutes / 60.0) * rule.amount_per_hour
    return total


def calculate_ot_components(
    profile: MonthProfile,
    start_time: str,
    end_time: str,
    rules: Sequence[AllowanceRule],
    extra_pay: float = 0.0,
) -> tuple[float, float, float, float, float]:
    """
    Returns:
      hours, base_pay, night_pay, allowance_pay
    """
    s = parse_hhmm(start_time)
    e = parse_hhmm(end_time)
    worked_minutes = interval_minutes(s, e)
    hours = worked_minutes / 60.0

    night_s = parse_hhmm(profile.night_start)
    night_e = parse_hhmm(profile.night_end)
    night_minutes = overlap_with_window(s, e, night_s, night_e)
    night_hours = night_minutes / 60.0
    regular_ot_hours = max(0.0, hours - night_hours)

    base_pay = profile.hourly_wage * profile.ot_multiplier * regular_ot_hours
    night_pay = profile.hourly_wage * profile.night_multiplier * night_hours
    full_hour_promo_units = max(0, int(hours))
    allowance_pay = extra_pay * full_hour_promo_units
    total = base_pay + night_pay + allowance_pay
    return hours, base_pay, night_pay, allowance_pay, total


def add_ot_record(
    year: int,
    month: int,
    work_date: str,
    start_time: str,
    end_time: str,
    memo: str = "",
    extra_pay: float = 0.0,
) -> OTRecord:
    profile = get_month_profile(year, month)
    rules = list_allowance_rules(active_only=True)
    hours, base_pay, night_pay, allowance_pay, total = calculate_ot_components(
        profile, start_time, end_time, rules, extra_pay=extra_pay
    )

    with db_connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO ot_records (
                year, month, work_date, start_time, end_time,
                hours, base_pay, night_pay, allowance_pay, total_pay, memo, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                year,
                month,
                work_date,
                start_time,
                end_time,
                hours,
                base_pay,
                night_pay,
                allowance_pay,
                total,
                memo,
            ),
        )
        record_id = cur.lastrowid

    return OTRecord(
        id=record_id,
        year=year,
        month=month,
        work_date=work_date,
        start_time=start_time,
        end_time=end_time,
        hours=hours,
        base_pay=base_pay,
        night_pay=night_pay,
        allowance_pay=allowance_pay,
        total_pay=total,
        memo=memo,
    )


def list_ot_records(year: int, month: int) -> list[OTRecord]:
    with db_connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM ot_records
            WHERE year=? AND month=?
            ORDER BY work_date, start_time, id
            """,
            (year, month),
        ).fetchall()

    records: list[OTRecord] = []
    for row in rows:
        records.append(
            OTRecord(
                id=row["id"],
                year=row["year"],
                month=row["month"],
                work_date=row["work_date"],
                start_time=row["start_time"],
                end_time=row["end_time"],
                hours=row["hours"],
                base_pay=row["base_pay"],
                night_pay=row["night_pay"],
                allowance_pay=row["allowance_pay"],
                total_pay=row["total_pay"],
                memo=row["memo"],
            )
        )
    return records


def delete_ot_record(record_id: int) -> None:
    with db_connect() as conn:
        conn.execute("DELETE FROM ot_records WHERE id=?", (record_id,))


def summary_for_month(year: int, month: int) -> dict[str, float | int]:
    with db_connect() as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS cnt,
                COALESCE(SUM(hours), 0) AS total_hours,
                COALESCE(SUM(base_pay), 0) AS base_pay,
                COALESCE(SUM(night_pay), 0) AS night_pay,
                COALESCE(SUM(allowance_pay), 0) AS allowance_pay,
                COALESCE(SUM(total_pay), 0) AS total_pay
            FROM ot_records
            WHERE year=? AND month=?
            """,
            (year, month),
        ).fetchone()

    return {
        "count": int(row["cnt"]),
        "hours": float(row["total_hours"]),
        "base_pay": float(row["base_pay"]),
        "night_pay": float(row["night_pay"]),
        "allowance_pay": float(row["allowance_pay"]),
        "total_pay": float(row["total_pay"]),
    }


def show_month_profile(profile: MonthProfile) -> None:
    print("\n현재 월 설정")
    print("-" * 64)
    print(f"대상 월: {profile.year}-{profile.month:02d}")
    print(f"시급: {fmt_won(profile.hourly_wage)}")
    print(f"기본 OT 배수: {profile.ot_multiplier:.1f}x")
    print(f"야간 OT 배수: {profile.night_multiplier:.1f}x")
    print(f"야간 시간: {profile.night_start} ~ {profile.night_end}")
    print(f"메모: {profile.note or '(없음)'}")
    print("-" * 64)


def visual_width(text: str) -> int:
    width = 0
    for ch in text:
        if ord(ch) > 127:
            width += 2
        else:
            width += 1
    return width


def format_table_cell(value: object, width: int, align: str = "left") -> str:
    text = str(value)
    current_width = visual_width(text)
    if align == "right":
        padding = max(0, width - current_width)
        return " " * padding + text
    padding = max(0, width - current_width)
    return text + " " * padding


def print_table(headers: Sequence[str], rows: Sequence[Sequence[object]], widths: Sequence[int], aligns: Sequence[str]) -> None:
    rendered = []
    for row in [headers, *rows]:
        rendered.append(
            "  ".join(
                format_table_cell(row[i], widths[i], aligns[i]) for i in range(len(widths))
            )
        )
    separator = "-" * max(visual_width(line) for line in rendered)
    print(separator)
    print(rendered[0])
    print(separator)
    for row in rendered[1:]:
        print(row)
    print(separator)


def print_records(records: Sequence[OTRecord]) -> None:
    print("\nOT 기록")
    headers = ["ID", "날짜", "기간", "시간", "기본OT", "야간OT", "추가수당", "합계", "메모"]
    widths = [4, 10, 13, 6, 12, 12, 12, 12, 20]
    aligns = ["right", "left", "left", "right", "right", "right", "right", "right", "left"]
    rows = []
    for r in records:
        time_range = f"{r.start_time}-{r.end_time}"
        rows.append(
            [
                r.id,
                r.work_date,
                time_range,
                f"{r.hours:.2f}",
                fmt_won(r.base_pay),
                fmt_won(r.night_pay),
                fmt_won(r.allowance_pay),
                fmt_won(r.total_pay),
                r.memo,
            ]
        )
    if not records:
        print("(기록 없음)")
        return
    print_table(headers, rows, widths, aligns)


def print_summary(year: int, month: int) -> None:
    profile = get_month_profile(year, month)
    summary = summary_for_month(year, month)
    records = list_ot_records(year, month)

    print("\n월별 예상 추가 수당 요약")
    print("=" * 64)
    print(f"{'대상':<12}: {year}-{month:02d}")
    print(f"{'시급':<12}: {fmt_won(profile.hourly_wage)}")
    print(f"{'기본 OT 배수':<12}: {profile.ot_multiplier:.1f}")
    print(f"{'야간 OT 배수':<12}: {profile.night_multiplier:.1f}")
    print(f"{'야간 시간':<12}: {profile.night_start} ~ {profile.night_end}")
    print("-" * 64)
    print(f"{'기록 수':<12}: {summary['count']}건")
    print(f"{'총 OT 시간':<12}: {summary['hours']:.2f}시간")
    print(f"{'기본 OT 수당 합계':<16}: {fmt_won(summary['base_pay'])}")
    print(f"{'야간 OT 수당 합계':<16}: {fmt_won(summary['night_pay'])}")
    print(f"{'프로모션 합계':<16}: {fmt_won(summary['allowance_pay'])}")
    print(f"{'총 예상 추가 수당':<16}: \033[31m{fmt_won(summary['total_pay'])}\033[0m")
    print("=" * 64)
    if records:
        print_records(records)


def ask_int(prompt: str, default: int | None = None) -> int:
    raw = get_line(prompt, str(default) if default is not None else None)
    if raw is None:
        raise GoBack()
    raw = raw.strip()
    if not raw:
        if default is None:
            raise ValueError("값이 필요합니다.")
        return int(default)
    return int(raw)


def ask_float(prompt: str, default: float | None = None) -> float:
    raw = get_line(prompt, str(default) if default is not None else None)
    if raw is None:
        raise GoBack()
    raw = raw.strip()
    if not raw:
        if default is None:
            raise ValueError("값이 필요합니다.")
        return float(default)
    return float(raw)


def ask_str(prompt: str, default: str | None = None) -> str:
    raw = get_line(prompt, default)
    if raw is None:
        raise GoBack()
    raw = raw.strip()
    if not raw and default is not None:
        return default
    return raw


def seed_default_rules() -> None:
    """Insert a common example rule set if none exists."""
    if list_allowance_rules(active_only=False):
        return
    defaults = [
        AllowanceRule(None, "18:00-19:00", "18:00", "19:00", 5000),
        AllowanceRule(None, "19:00-20:00", "19:00", "20:00", 10000),
        AllowanceRule(None, "20:00-21:00", "20:00", "21:00", 15000),
        AllowanceRule(None, "21:00-22:00", "21:00", "22:00", 20000),
        AllowanceRule(None, "22:00-06:00", "22:00", "06:00", 25000),
    ]
    for rule in defaults:
        add_allowance_rule(rule)


def menu_profile_setup() -> None:
    year = ask_int("연도", date.today().year)

    current = get_month_profile(year, date.today().month)
    hourly_wage = ask_float("시급", current.hourly_wage)
    ot_multiplier = ask_float("기본 OT 배수", current.ot_multiplier)
    night_multiplier = ask_float("야간 OT 배수", current.night_multiplier)
    night_start = normalize_time_input(ask_str("야간 시작(HH:MM)", current.night_start))
    night_end = normalize_time_input(ask_str("야간 종료(HH:MM)", current.night_end))
    note = ask_str("메모", current.note)

    _ = parse_hhmm(night_start)
    _ = parse_hhmm(night_end)

    for month in range(1, 13):
        upsert_month_profile(
            MonthProfile(
                year=year,
                month=month,
                hourly_wage=hourly_wage,
                ot_multiplier=ot_multiplier,
                night_multiplier=night_multiplier,
                night_start=night_start,
                night_end=night_end,
                note=note,
            )
        )
    print(f"{year}년 연 설정을 저장했습니다.")


def menu_add_record() -> None:
    year = ask_int("연도", date.today().year)
    month = ask_int("월(1~12)", date.today().month)
    if not 1 <= month <= 12:
        raise ValueError("월은 1~12 사이여야 합니다.")

    work_date = ask_str("근무일(YYYY-MM-DD)", date.today().strftime("%Y-%m-%d"))
    start_time = normalize_time_input(ask_str("시작시간(HH:MM)", "22:00"))
    end_time = normalize_time_input(ask_str("종료시간(HH:MM)", "06:00"))
    extra_pay = ask_float("프로모션/추가 수당(원/1시간 기준, 0 가능)", 0.0)
    memo = ask_str("메모", "")

    record = add_ot_record(year, month, work_date, start_time, end_time, memo, extra_pay=extra_pay)
    print("\n기록 저장 완료")
    print("-" * 64)
    print(f"일자: {record.work_date}")
    print(f"시간: {record.start_time} ~ {record.end_time}")
    print(f"총 시간: {record.hours:.2f}시간")
    print(f"기본 OT: {fmt_won(record.base_pay)}")
    print(f"야간 OT: {fmt_won(record.night_pay)}")
    print(f"프로모션/추가 수당: {fmt_won(record.allowance_pay)}")
    print(f"합계: {fmt_won(record.total_pay)}")
    print("-" * 64)


def menu_add_rule() -> None:
    name = ask_str("룰 이름", "예: 18:00-19:00")
    start_time = normalize_time_input(ask_str("시작시간(HH:MM)", "18:00"))
    end_time = normalize_time_input(ask_str("종료시간(HH:MM)", "19:00"))
    amount = ask_float("시간당 추가 수당", 5000.0)
    _ = parse_hhmm(start_time)
    _ = parse_hhmm(end_time)
    add_allowance_rule(AllowanceRule(None, name, start_time, end_time, amount, True))
    print("추가 수당 룰을 저장했습니다.")


def menu_list_rules() -> None:
    rules = list_allowance_rules(active_only=False)
    print("\n추가 수당 룰")
    headers = ["ID", "활성", "이름", "구간", "시간당 수당"]
    widths = [4, 4, 18, 13, 12]
    aligns = ["right", "left", "left", "left", "right"]
    rows = []
    for r in rules:
        rows.append(
            [
                r.id,
                "Y" if r.active else "N",
                r.name,
                f"{r.start_time}-{r.end_time}",
                fmt_won(r.amount_per_hour),
            ]
        )
    if not rules:
        print("(등록된 룰 없음)")
        return
    print_table(headers, rows, widths, aligns)


def menu_toggle_rule() -> None:
    rule_id = ask_int("활성/비활성 변경할 룰 ID")
    active_raw = ask_str("활성화? (y/n)", "y").lower()
    active = active_raw in ("y", "yes", "1", "true", "t")
    set_allowance_rule_active(rule_id, active)
    print("변경했습니다.")


def menu_delete_rule() -> None:
    rule_id = ask_int("삭제할 룰 ID")
    delete_allowance_rule(rule_id)
    print("삭제했습니다.")


def menu_list_records() -> None:
    year = ask_int("연도", date.today().year)
    month = ask_int("월(1~12)", date.today().month)
    clear_screen()
    print_records(list_ot_records(year, month))


def menu_summary() -> None:
    year = ask_int("연도", date.today().year)
    month = ask_int("월(1~12)", date.today().month)
    clear_screen()
    print_summary(year, month)


def menu_delete_record() -> None:
    record_id = ask_int("삭제할 OT 기록 ID")
    delete_ot_record(record_id)
    print("삭제했습니다.")


def interactive() -> None:
    init_db()
    seed_default_rules()

    while True:
        clear_screen()
        print("OT 기록기")
        print("=" * 64)
        print("1. 연 설정(시급/배수/야간시간)")
        print("2. OT 기록 추가")
        print("3. 월 OT 기록 목록")
        print("4. 월 요약")
        print("5. OT 기록 삭제")
        print("0. 종료")
        print("=" * 64)

        choice = get_single_key("선택: ").strip()

        try:
            if choice == "1":
                menu_profile_setup()
                wait_any_key()
            elif choice == "2":
                menu_add_record()
                wait_any_key()
            elif choice == "3":
                menu_list_records()
                wait_any_key()
            elif choice == "4":
                menu_summary()
                wait_any_key()
            elif choice == "5":
                menu_delete_record()
                wait_any_key()
            elif choice == "0":
                print("종료합니다.")
                break
        except GoBack:
            continue
        except Exception as exc:
            print(f"[오류] {exc}")
            wait_any_key()


def main() -> None:
    interactive()


if __name__ == "__main__":
    main()
