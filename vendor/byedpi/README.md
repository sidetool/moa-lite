# ByeDPI v0.17.3

Official upstream: https://github.com/hufrea/byedpi/tree/v0.17.3 (MIT, see LICENSE).
`ciadpi-linux-x64` is the unmodified, statically linked Linux x86_64 release binary.
It is bundled only in the Node function, never the browser assets.

Download: https://github.com/hufrea/byedpi/releases/download/v0.17.3/byedpi-17.3-x86_64.tar.gz

- Archive SHA-256: `98f73c32eacb571ebd88d790f6376ed9e70f02d44c1fe862472ecea75cd7117d`
- Extracted `ciadpi-x86_64` SHA-256: `c70e87c6168af1832b21641a98bb53e3500b1daf6a5df8bfd22fac4a9294abda`

To reproduce, download that archive, verify its SHA-256, extract `ciadpi-x86_64`,
verify the binary SHA-256, and copy it to `ciadpi-linux-x64` with mode 0755.
Updates require explicitly replacing the version, checksums, binary and license,
then rerunning native relay and Vercel packaging tests. Builds never download executable code.
