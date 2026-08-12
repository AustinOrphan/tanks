# Third-party notices

<!-- GENERATED FILE -- do not edit by hand. Run `npm run notices`. -->

Tanks! bundles the software listed below. Every one of these licences requires its
copyright notice and permission notice to travel with any copy of the software, and
the build strips both: the minified bundle in `dist/` keeps the code and drops the
notices. This file is where they travel -- for anyone receiving this repository.
It is NOT copied into `dist/`, so a deployed build still carries neither.

Scope: the packages whose code actually reaches `dist/`, which is the lockfile's
non-development closure. That set was checked against the artifact rather than
assumed -- a `--sourcemap` build names every module that contributed code, and the
only `node_modules/` packages among them are the ones below. Build-time tooling
(vite, vitest, typescript, jsdom and their trees) is deliberately absent: none of it
ships, so none of it is distributed, so none of its notices are owed here.

The terms of Tanks! itself are in [LICENSE](LICENSE), and are not affected by
anything in this file.

## howler 2.2.4

- Licence: MIT
- Homepage: https://howlerjs.com
- Source: https://github.com/goldfire/howler.js
- Reproduced from: `node_modules/howler/LICENSE.md`

```
Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## three 0.169.0

- Licence: MIT
- Homepage: https://threejs.org/
- Source: https://github.com/mrdoob/three.js
- Reproduced from: `node_modules/three/LICENSE`

```
The MIT License

Copyright © 2010-2024 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
