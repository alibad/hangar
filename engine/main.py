"""Hangar's bundled local project engine. Python standard library only."""
import argparse
import sys

if sys.version_info < (3, 10):
    sys.exit("Hangar's project engine needs Python 3.10 or newer.")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["serve", "scan"], nargs="?", default="serve")
    parser.add_argument("--port", type=int, default=7789)
    parser.add_argument("--local", action="store_true", help="Scan disk without refreshing GitHub")
    args = parser.parse_args()
    if args.command == "scan":
        from hangar_engine.scan import run
        run(github=not args.local, progress=print)
    else:
        from hangar_engine.server import serve
        serve(port=args.port, open_browser=False)

if __name__ == "__main__":
    main()
