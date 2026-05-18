# System Data Cleaner

A small native macOS utility for finding common contributors to oversized
System Data storage.

The app scans common cache, log, developer, backup, simulator, update, virtual
memory, and local snapshot locations. It only moves explicitly selected
cleanable cache-style items to Trash. Review-only locations are opened in
Finder so you can decide what to keep.

Scans publish partial results while they run. The live scan panel shows the
current path, progress through scan targets, and recently found large entries.
Large folder and forensic results are expandable: open a folder to size its
immediate children, then keep expanding downward until the large storage holder
is visible. Expansion uses a one-pass disk usage scan for the selected folder
so very large directories do not require a separate recursive walk per child.

For large unexplained System Data, use **Deep Scan**. It breaks down the
largest folders under Library, Application Support, Containers, Group
Containers, Developer, temporary system folders, Trash, and shared support
locations. This is meant to identify the real space holder before you delete
anything.

If System Data still looks wrong, use **Forensic Scan**. It runs a broader
read-only disk usage scan across the APFS Data, VM, Update, and Preboot volumes
and shows every folder over 500 MB that macOS reports. Forensic Scan can take a
few minutes. If it reports denied paths, grant Full Disk Access to the app or to
Terminal and run it again.

## Run

```sh
cd apps/system-data-cleaner
swift run SystemDataCleaner
```

## Safety Model

- Cleanable entries are rebuildable caches or logs and are moved to Trash.
- Review entries may contain personal data, backups, archives, or app state.
- Protected entries usually need administrator permissions and are reveal-only.
- Time Machine local snapshots are listed separately because macOS may already
  count them as purgeable space.
- Deep Scan results are reveal-only because they can point at personal app data,
  virtual machines, backups, or release artifacts.
- Forensic Scan is also reveal-only. It is a map for investigation, not an
  automatic deletion feature.
