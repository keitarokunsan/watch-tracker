"""Notification senders for Discord Webhook and HTML Email (SMTP)."""

from __future__ import annotations

import html
import json
import smtplib
import urllib.error
import urllib.request
from email.message import EmailMessage
from typing import Any

AMAZON_LEAVING_SOON_URL = "https://www.amazon.co.jp/s?rh=n%3A4217521051"


def _format_days_badge(item: dict[str, Any]) -> str:
    days = item.get("daysLeft")
    if days is None:
        return "期限未確定"
    if days <= 0:
        return "本日終了"
    return f"あと{days}日"


def _format_type_label(show_type: str | None) -> str:
    return "ドラマ・アニメ" if show_type == "series" else "映画"


def select_notification_items(
    items: list[dict[str, Any]],
    previous_history: dict[str, Any],
    urgent_days: int = 3,
    force_notify: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    """Select newly expiring, watchlist urgent, and general urgent items.

    Uses previous_history to avoid repeating identical notifications daily.
    """
    seen_ids: dict[str, Any] = previous_history.get("seen", {})
    notified_watchlist_milestones: dict[str, list[int]] = previous_history.get(
        "watchlistMilestones", {}
    )
    notified_urgent: set[str] = set(previous_history.get("urgentNotified", []))

    new_items: list[dict[str, Any]] = []
    watchlist_alerts: list[dict[str, Any]] = []
    urgent_items: list[dict[str, Any]] = []

    for item in items:
        item_id = item["id"]
        days = item.get("daysLeft")
        is_new = item_id not in seen_ids

        if is_new or force_notify:
            new_items.append(item)

        if item.get("inWatchlist"):
            if is_new or force_notify:
                watchlist_alerts.append(item)
            elif days is not None:
                prev_marks = set(notified_watchlist_milestones.get(item_id, []))
                for milestone in (7, 3, 1, 0):
                    if days <= milestone and milestone not in prev_marks:
                        watchlist_alerts.append(item)
                        break

        if days is not None and days <= urgent_days:
            if item_id not in notified_urgent or force_notify:
                urgent_items.append(item)

    # Deduplicate watchlist alerts preserving order
    dedup_watchlist: list[dict[str, Any]] = []
    wl_ids: set[str] = set()
    for it in watchlist_alerts:
        if it["id"] not in wl_ids:
            wl_ids.add(it["id"])
            dedup_watchlist.append(it)

    return {
        "watchlist": dedup_watchlist,
        "new": [it for it in new_items if it["id"] not in wl_ids],
        "urgent": [
            it
            for it in urgent_items
            if it["id"] not in wl_ids and it["id"] not in {x["id"] for x in new_items}
        ],
    }


def update_history(
    items: list[dict[str, Any]],
    previous_history: dict[str, Any],
    urgent_days: int = 3,
    updated_at: str = "",
) -> dict[str, Any]:
    """Build updated history state retaining only currently active expiring IDs."""
    active_ids = {item["id"] for item in items}
    prev_milestones: dict[str, list[int]] = previous_history.get("watchlistMilestones", {})
    prev_urgent = set(previous_history.get("urgentNotified", []))

    seen: dict[str, Any] = {}
    new_milestones: dict[str, list[int]] = {}
    new_urgent: list[str] = []

    for item in items:
        item_id = item["id"]
        days = item.get("daysLeft")
        seen[item_id] = {
            "title": item.get("displayTitle", ""),
            "expiresDate": item.get("expiresDate"),
        }

        if item.get("inWatchlist"):
            marks = set(prev_milestones.get(item_id, []))
            if days is not None:
                for m in (7, 3, 1, 0):
                    if days <= m:
                        marks.add(m)
            new_milestones[item_id] = sorted(marks)

        if (days is not None and days <= urgent_days) or item_id in prev_urgent:
            if item_id in active_ids:
                new_urgent.append(item_id)

    return {
        "updatedAt": updated_at,
        "seen": seen,
        "watchlistMilestones": new_milestones,
        "urgentNotified": sorted(set(new_urgent)),
    }


def build_discord_payloads(
    selection: dict[str, list[dict[str, Any]]],
    total_count: int,
    pages_url: str = "",
) -> list[dict[str, Any]]:
    """Build one or more Discord webhook payloads respecting Discord embed limits."""
    watchlist_items = selection.get("watchlist", [])
    new_items = selection.get("new", [])
    urgent_items = selection.get("urgent", [])

    if not watchlist_items and not new_items and not urgent_items:
        return []

    embeds: list[dict[str, Any]] = []

    nav_links = [f"[Amazon公式: 30日以内に終了する作品一覧]({AMAZON_LEAVING_SOON_URL})"]
    if pages_url:
        nav_links.insert(0, f"[ポスター一覧ページを開く]({pages_url})")
    footer_links = " | ".join(nav_links)

    def format_line(it: dict[str, Any]) -> str:
        title = it["displayTitle"]
        link = it.get("primeLink") or AMAZON_LEAVING_SOON_URL
        date_text = it.get("expiresDateLabel") or "期限未確定"
        badge = _format_days_badge(it)
        kind = _format_type_label(it.get("showType"))
        return f"• **[{title}]({link})** — `{date_text}`（{badge}・{kind}）"

    def add_section_embeds(
        heading: str,
        section_items: list[dict[str, Any]],
        color: int,
        max_items: int = 25,
    ) -> None:
        if not section_items:
            return
        lines: list[str] = []
        shown = section_items[:max_items]
        for it in shown:
            line = format_line(it)
            if sum(len(x) + 1 for x in lines) + len(line) > 3600:
                break
            lines.append(line)
        remaining = len(section_items) - len(lines)
        if remaining > 0:
            lines.append(f"…ほか **{remaining}件**（一覧ページで確認できます）")

        embed: dict[str, Any] = {
            "title": f"{heading}（{len(section_items)}件）",
            "description": "\n".join(lines),
            "color": color,
        }
        first_poster = next((it.get("posterUrl") for it in shown if it.get("posterUrl")), "")
        if first_poster:
            embed["thumbnail"] = {"url": first_poster}
        embeds.append(embed)

    add_section_embeds("★ ウォッチリスト作品の配信終了アラート", watchlist_items, 0xF59E0B)
    add_section_embeds("新規に配信終了予定へ追加された作品", new_items, 0x00A8E1)
    add_section_embeds("まもなく配信終了（残りわずか）", urgent_items, 0xEF4444)

    if embeds:
        embeds[-1]["footer"] = {
            "text": f"Prime Video 見放題終了トラッカー / 現在合計 {total_count} 件"
        }

    header_content = (
        f"**Prime Video 見放題終了アップデート**\n"
        f"{footer_links}"
    )

    # Discord allows up to 10 embeds per message
    payloads: list[dict[str, Any]] = []
    for idx in range(0, len(embeds), 10):
        chunk = embeds[idx : idx + 10]
        payload: dict[str, Any] = {"embeds": chunk}
        if idx == 0:
            payload["content"] = header_content
        payloads.append(payload)

    return payloads


def send_discord_notification(
    webhook_url: str,
    selection: dict[str, list[dict[str, Any]]],
    total_count: int,
    pages_url: str = "",
    timeout: int = 15,
) -> int:
    """Send notification payloads to a Discord webhook. Returns sent message count."""
    payloads = build_discord_payloads(selection, total_count, pages_url=pages_url)
    sent = 0
    for payload in payloads:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            webhook_url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "prime-video-expiring-tracker/1.0",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if 200 <= resp.status < 300:
                sent += 1
    return sent


def build_email_html(
    selection: dict[str, list[dict[str, Any]]],
    total_count: int,
    pages_url: str = "",
) -> tuple[str, str]:
    """Return (subject, html_body) for email notification."""
    watchlist_items = selection.get("watchlist", [])
    new_items = selection.get("new", [])
    urgent_items = selection.get("urgent", [])

    parts: list[str] = []
    if watchlist_items:
        parts.append(f"★ウォッチリスト{len(watchlist_items)}件")
    if new_items:
        parts.append(f"新規{len(new_items)}件")
    if urgent_items:
        parts.append(f"終了間近{len(urgent_items)}件")
    subject = f"[Prime Video配信終了] {' / '.join(parts)}"

    def render_section(title: str, accent: str, section_items: list[dict[str, Any]]) -> str:
        if not section_items:
            return ""
        rows: list[str] = []
        for it in section_items[:40]:
            esc_title = html.escape(it["displayTitle"])
            esc_link = html.escape(it.get("primeLink") or AMAZON_LEAVING_SOON_URL)
            esc_date = html.escape(it.get("expiresDateLabel") or "期限未確定")
            esc_badge = html.escape(_format_days_badge(it))
            esc_kind = html.escape(_format_type_label(it.get("showType")))
            poster = it.get("posterUrl") or ""
            img_cell = (
                f'<img src="{html.escape(poster)}" alt="{esc_title}" '
                f'width="56" height="84" style="display:block;border-radius:6px;object-fit:cover;">'
                if poster
                else '<div style="width:56px;height:84px;border-radius:6px;background:#1e293b;color:#94a3b8;font-size:10px;line-height:84px;text-align:center;">NO IMG</div>'
            )
            rows.append(
                f"""
                <tr>
                  <td style="padding:10px 12px 10px 0;width:56px;vertical-align:top;">
                    <a href="{esc_link}" target="_blank" rel="noopener">{img_cell}</a>
                  </td>
                  <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;vertical-align:top;">
                    <div style="font-size:15px;font-weight:700;line-height:1.4;">
                      <a href="{esc_link}" target="_blank" rel="noopener" style="color:#0f172a;text-decoration:none;">{esc_title}</a>
                    </div>
                    <div style="margin-top:4px;font-size:13px;color:#475569;">
                      <span style="display:inline-block;padding:2px 8px;border-radius:999px;background:{accent};color:#ffffff;font-weight:600;font-size:12px;">{esc_badge}</span>
                      <span style="margin-left:8px;">期限: {esc_date}</span>
                      <span style="margin-left:8px;color:#64748b;">({esc_kind})</span>
                    </div>
                    <div style="margin-top:6px;">
                      <a href="{esc_link}" target="_blank" rel="noopener" style="font-size:12px;color:#0284c7;text-decoration:underline;">Prime Videoで開く &rarr;</a>
                    </div>
                  </td>
                </tr>
                """
            )
        extra = ""
        if len(section_items) > 40:
            extra = f'<p style="font-size:13px;color:#64748b;">ほか {len(section_items) - 40} 件は一覧ページで確認できます。</p>'
        return f"""
        <h2 style="margin:24px 0 8px;padding-left:10px;border-left:4px solid {accent};font-size:16px;color:#0f172a;">
          {html.escape(title)}（{len(section_items)}件）
        </h2>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;">
          {''.join(rows)}
        </table>
        {extra}
        """

    cta_buttons: list[str] = []
    if pages_url:
        cta_buttons.append(
            f'<a href="{html.escape(pages_url)}" target="_blank" rel="noopener" '
            f'style="display:inline-block;padding:10px 16px;margin-right:8px;margin-bottom:8px;border-radius:8px;background:#0284c7;color:#ffffff;font-weight:600;text-decoration:none;font-size:14px;">ポスター一覧ページを開く</a>'
        )
    cta_buttons.append(
        f'<a href="{html.escape(AMAZON_LEAVING_SOON_URL)}" target="_blank" rel="noopener" '
        f'style="display:inline-block;padding:10px 16px;margin-bottom:8px;border-radius:8px;background:#0f172a;color:#ffffff;font-weight:600;text-decoration:none;font-size:14px;">Amazon公式: 30日以内に終了一覧</a>'
    )

    body = f"""<!doctype html>
<html lang="ja">
<body style="margin:0;padding:16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Hiragino Kaku Gothic ProN',Meiryo,sans-serif;color:#0f172a;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">
    <h1 style="margin:0 0 8px;font-size:20px;color:#0f172a;">Prime Video 見放題終了アップデート</h1>
    <p style="margin:0 0 16px;font-size:13px;color:#475569;">現在トラッキング中の終了予定作品: <strong>{total_count}件</strong></p>
    <div>{''.join(cta_buttons)}</div>
    {render_section("★ ウォッチリスト作品", "#d97706", watchlist_items)}
    {render_section("新規に配信終了予定へ追加", "#0284c7", new_items)}
    {render_section("まもなく配信終了（残りわずか）", "#dc2626", urgent_items)}
  </div>
</body>
</html>
"""
    return subject, body


def send_email_notification(
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_pass: str,
    mail_to: str,
    selection: dict[str, list[dict[str, Any]]],
    total_count: int,
    mail_from: str = "",
    pages_url: str = "",
) -> bool:
    """Send an HTML email summary via SMTP (STARTTLS or SSL)."""
    if not any(selection.values()):
        return False

    subject, html_body = build_email_html(selection, total_count, pages_url=pages_url)
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = mail_from or smtp_user
    msg["To"] = mail_to
    msg.set_content(
        f"Prime Video 配信終了アップデート（合計 {total_count} 件）\n"
        f"一覧ページ: {pages_url or AMAZON_LEAVING_SOON_URL}\n"
        f"Amazon公式 30日以内終了一覧: {AMAZON_LEAVING_SOON_URL}\n"
    )
    msg.add_alternative(html_body, subtype="html")

    if smtp_port == 465:
        with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=20) as server:
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
    else:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
    return True
