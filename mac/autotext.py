#!/usr/bin/env python3
"""Knotty auto-texter. Runs on Alejandro's Mac every minute (launchd).
1. Re-sends any order alert the site couldn't get to ntfy (from the home connection).
2. Sends the confirmation text for new orders through the Messages app
   (SMS via his iPhone), then marks each one Texted.
Installed copy: ~/Library/Application Support/knotty/ (launchd can't read the Desktop)."""
import json, os, subprocess, sys, urllib.request

SITE = "https://knottybynature.lightsandheights.workers.dev"
HERE = os.path.dirname(os.path.abspath(__file__))
KEY = next(l.split("=", 1)[1].strip() for l in open(os.path.join(HERE, "admin.key" if os.path.exists(os.path.join(HERE, "admin.key")) else os.path.join("..", ".dev.vars"))) if l.startswith("ADMIN_KEY="))

SEND = '''on run argv
  set theNumber to item 1 of argv
  set theText to item 2 of argv
  tell application "Messages"
    set smsAcct to missing value
    repeat with i from 1 to (count accounts)
      try
        if (service type of account i) is SMS and (enabled of account i) then set smsAcct to account i
      end try
    end repeat
    if smsAcct is missing value then error "No SMS account in Messages"
    send theText to participant theNumber of smsAcct
  end tell
end run'''

def call(path, data=None):
    req = urllib.request.Request(SITE + path, data=json.dumps(data).encode() if data else None,
                                 headers={"content-type": "application/json", "user-agent": "knotty-autotext"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def main():
    try:
        pending = call(f"/api/pending?key={KEY}&v=2")
    except Exception as e:
        print("fetch failed:", e); return
    for a in pending.get("alerts", []):
        try:
            req = urllib.request.Request("https://ntfy.sh/", data=json.dumps(a["payload"]).encode(),
                                         headers={"content-type": "application/json"})
            urllib.request.urlopen(req, timeout=20).read()
            call(f"/api/status?key={KEY}", {"key": a["key"], "field": "alerted", "value": True})
            print(f"{a['id']} alert re-sent from Mac")
        except Exception as e:
            print(f"{a['id']} alert re-send failed: {e}")
    for o in pending.get("texts", []):
        r = subprocess.run(["osascript", "-e", SEND, o["to"], o["text"]], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"{o['id']} send failed: {r.stderr.strip()}"); continue
        call(f"/api/status?key={KEY}", {"key": o["key"], "field": "texted", "value": True})
        print(f"{o['id']} texted {o['to'][-4:]}")

if __name__ == "__main__":
    main()
