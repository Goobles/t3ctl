# Changelog

## [0.9.1](https://github.com/Goobles/t3ctl/compare/v0.9.0...v0.9.1) (2026-10-06)


### Bug Fixes

* read ssh-tunnelled hosts over http in export prompts ([8608ff9](https://github.com/Goobles/t3ctl/commit/8608ff95f5acb6568664a0c0216daa06115cd691))
* support T3 Code orchestration protocol 2 alongside protocol 1 ([220d30c](https://github.com/Goobles/t3ctl/commit/220d30cadc2a2804b01d5fec39668d3ce7637481))

## [0.9.0](https://github.com/Goobles/t3ctl/compare/v0.8.0...v0.9.0) (2026-10-05)


### Features

* start a thread in a new server-made worktree with thread create --new-worktree ([16ede96](https://github.com/Goobles/t3ctl/commit/16ede965c0dc970d4873e529b9c8f3449a4c6b90))
* start a thread in a new server-made worktree with thread create --new-worktree ([ff26422](https://github.com/Goobles/t3ctl/commit/ff26422e66e7c8d0c659e62d1c7c926869055711))


### Bug Fixes

* harden the websocket client behind thread create --new-worktree ([34b84c8](https://github.com/Goobles/t3ctl/commit/34b84c8e80513ef705c23a640374d69b960dd9e8))

## [0.8.0](https://github.com/Goobles/t3ctl/compare/v0.7.0...v0.8.0) (2026-10-02)


### Features

* expose thread snooze/unsnooze and standalone runtime-mode ([4e8afbc](https://github.com/Goobles/t3ctl/commit/4e8afbc57f6d4bdf5f0306dce0ed9cb4bdeb7324))
* expose thread snooze/unsnooze and standalone runtime-mode ([78326d7](https://github.com/Goobles/t3ctl/commit/78326d7888e78e1681636d324e7475bef2a7f7ec))
* mint ssh host tokens with a running desktop app's own CLI ([befee0a](https://github.com/Goobles/t3ctl/commit/befee0a8e8751caaf64a960488f35f4c8725543f))
* mint ssh host tokens with a running desktop app's own CLI ([e7c0287](https://github.com/Goobles/t3ctl/commit/e7c0287d2472fda0deac209c80b6c1ee1db2ddfc))


### Bug Fixes

* fall back to npx when a desktop app was upgraded under its server ([22b28a7](https://github.com/Goobles/t3ctl/commit/22b28a7f1cd587848aae7a0e425d78b61e0ca02b))

## [0.7.0](https://github.com/Goobles/t3ctl/compare/v0.6.0...v0.7.0) (2026-10-01)


### Features

* set model options such as effort with --option ([10f726d](https://github.com/Goobles/t3ctl/commit/10f726d1c4e20a95867733f6b3d2f040e5928703))
* set model options such as effort with --option ([ca31351](https://github.com/Goobles/t3ctl/commit/ca31351b5ad14feaf1dec90f8ea0d9ef0a9d419c))


### Bug Fixes

* refuse writes to a server another T3 server has superseded ([2399219](https://github.com/Goobles/t3ctl/commit/2399219a26b3d89780290d2cd77bea45cef2584f))
* refuse writes to a server that another T3 server has superseded ([f588d56](https://github.com/Goobles/t3ctl/commit/f588d5654ac15510ada988b5358c69dafb607fb1))
* report a restarted server as moved, not as a second server ([02b4e14](https://github.com/Goobles/t3ctl/commit/02b4e147f4d57ea1ce8a3c6c4cf463f90c232993))

## [0.6.0](https://github.com/Goobles/t3ctl/compare/v0.5.0...v0.6.0) (2026-09-14)


### Features

* add `export prompts` ([#13](https://github.com/Goobles/t3ctl/issues/13)) ([6479648](https://github.com/Goobles/t3ctl/commit/6479648503ee818cfe24421bca51b19963f240ab))
* register a host from its ssh login alone ([b793cef](https://github.com/Goobles/t3ctl/commit/b793ceff554a447185209414b43e81c0352d1c5c))
* register a host from its ssh login alone ([2f08702](https://github.com/Goobles/t3ctl/commit/2f0870209d291652effabf48d87eafe79856a0ca))

## [0.5.0](https://github.com/Goobles/t3ctl/compare/v0.4.0...v0.5.0) (2026-09-04)


### Features

* move the CLI onto commander ([#10](https://github.com/Goobles/t3ctl/issues/10)) ([bf3f6ff](https://github.com/Goobles/t3ctl/commit/bf3f6ffdbd21864f54607f4dd881d557108dfc41))

## [0.4.0](https://github.com/Goobles/t3ctl/compare/v0.3.0...v0.4.0) (2026-09-04)


### Features

* add thread send, rename and retitle ([#6](https://github.com/Goobles/t3ctl/issues/6)) ([0c87871](https://github.com/Goobles/t3ctl/commit/0c878713dddedc5c81a167d9d18b608b087c7664))


### Bug Fixes

* make thread retitle report whether a title was actually generated ([#8](https://github.com/Goobles/t3ctl/issues/8)) ([6dfb71d](https://github.com/Goobles/t3ctl/commit/6dfb71d12361298e204a93f41d3141a1194b331a))

## [0.3.0](https://github.com/Goobles/t3ctl/compare/v0.2.1...v0.3.0) (2026-09-04)


### Features

* verify hosts with the environment descriptor on add ([#4](https://github.com/Goobles/t3ctl/issues/4)) ([65e74e3](https://github.com/Goobles/t3ctl/commit/65e74e37cd441578cc92884457a2c63c69bab0df))

## [0.2.1](https://github.com/Goobles/t3ctl/compare/v0.2.0...v0.2.1) (2026-09-04)


### Bug Fixes

* print usage before requiring a host, and exit non-zero ([91a48c2](https://github.com/Goobles/t3ctl/commit/91a48c2836508342e601bd8d1a5792c789953fbf))
