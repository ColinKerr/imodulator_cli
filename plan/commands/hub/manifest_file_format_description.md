# Cloud Backed SQLite Manifest file format (version 4)

All integers are unsigned and big-endian. The header is 24 bytes:

| offset | field |
| --- | --- |
| 0 | manifest format version (4) |
| 4 | block size in bytes |
| 8 | number of databases |
| 12 | number of delete list entries |
| 16 | block id size in bytes (12-32) |
| 20 | largest database id assigned |

Then one 152 byte header per database, the *i*th at offset `24 + 152 * i`:

| offset | field |
| --- | --- |
| +0 | database id (1 or greater) |
| +4 | parent id (0 means no parent) |
| +8 | database version |
| +12 | offset of this database's block array |
| +16 | number of blocks in the database |
| +20 | entries in the block array |
| +24 | display name, 128 bytes of UTF-8, zero padded |

**The high bit (`0x80000000`) of the block count at +16 flags the database as deleted** and
must be masked off before the count is used.

Following the header is the delete list (`nDelete` entries of `blockIdSize + 8` bytes) followed by the block array of each database. Block arrays come in two shapes: a database with no parent stores block ids packed one after another, while a database with a parent stores only the entries that differ from it, each a 32-bit block index followed by a block id. Neither is needed to list databases, but both matter for mapping a SQLite page to its block. The entry count at +20 only applies to the delta form; a database with no parent leaves it 0 no matter how many blocks it has.

The block arrays begin at `24 + 152 * 4 = 632`, a parentless database consumes `blocks * 16` bytes, a child consumes `entries * (4 + 16)` bytes, and the last one ends precisely at the file size.

## Source of truth

The layout above is taken from `bcvManifestParse` in
`iModelCore/BeSQLite/SQLite/bcvutil.c` of the imodel-native repository, which is the parser
Cloud Backed SQLite actually uses.
