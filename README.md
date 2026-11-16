# Fantasy GP (static site)

Built by `node game/tools/build_site.mjs` in the source project. Everything here is static: open `index.html` through
any web server (not as a file: the browser blocks module scripts from `file://`).

    python -m http.server 8765        then open http://localhost:8765

`index.html` loads everything from `v/<build>/`, named after the build's content. A new build adds a new folder and
keeps the previous one, so pages already open keep working after an update.

Saves live in the browser's local storage (keys starting `fgp.`) and in save files players download.

See CREDITS.md for data sources and licences.
