"""Explainable local suggestions from native session titles, never repo names.

These conservative rules are a starting point for review, not semantic certainty.
No transcript bodies are stored or sent to a model. Ambiguous matches abstain.
"""
import re

TOPICS = (
    ("creative-assets", "Creative assets", r"\b(sprite|sprites|texture|textures|logo|logos|branding|soundtrack|music|voice|voices|tts|animation|animations)\b"),
    ("connected-work", "Connected AI workspace", r"\b(hangar|atlas|codex|claude|agent|agents|fleet|inference|model routing|remote machine|session grouping)\b"),
    ("gameplay", "Gameplay & worlds", r"\b(gameplay|campaign|mission|missions|terrain|skirmish|rts|openra|pathfinding|game balance)\b"),
    ("publishing", "Publishing & teaching", r"\b(presentation|slides|talk|workshop|tutorial|walkthrough|speaker|course|lesson|lessons)\b"),
    ("research", "Research & evidence", r"\b(research|citations|citation|sources|fact.check|visa|relocation|immigration)\b"),
    ("reliability", "Reliability & operations", r"\b(deploy|deployment|ci|regression|backup|monitoring|crash|startup|installation|install|telemetry)\b"),
)


def suggest(title):
    if not isinstance(title, str) or len(title.strip()) < 8:
        return None
    matches = []
    for key, name, pattern in TOPICS:
        terms = sorted(set(m.group(0).lower() for m in re.finditer(pattern, title, re.I)))
        if terms:
            matches.append((len(terms), key, name, terms))
    matches.sort(reverse=True)
    if not matches or len(matches) > 1 and matches[0][0] == matches[1][0]:
        return None
    _, key, name, terms = matches[0]
    return {"id": "purpose:" + key, "name": name, "confidence": "tentative",
            "reason": "Title mentions " + ", ".join(terms[:4]) + "; review the session before accepting"}
