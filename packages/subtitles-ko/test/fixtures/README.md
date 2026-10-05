These fixtures contain authored test metadata and short synthetic subtitle text, under the project license. They contain no recorded creator responses or downloaded subtitle content. The ZIPs exercise episode selection, path traversal, encoding and archive limits; `cp949.zip` intentionally preserves raw CP949 filename bytes.

A few neutral known titles in tests outside this directory exercise the existing built-in alias/offset and named-season rules. Their responses and identifiers are invented, and all HTTP boundaries are mocked.

`lite-episodes.7z`, `lite-encrypted.7z`, and `lite-episodes.tar` contain authored two-line test subtitles. The TAR also contains a traversal name and a symlink to test rejection; extraction never writes these entries. They let CI verify the WASM decoder without installing archive tools.
