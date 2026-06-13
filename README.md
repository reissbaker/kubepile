# kubepile

`kubepile` compiles separate kubeconfig files from `~/.config/kubepile` into a single `~/.kube/config`.

Each `*.yaml` or `*.yml` file contributes one context. The output context name is the source filename without its extension, so `~/.config/kubepile/eks.yaml` becomes a context named `eks`. The compiled kubeconfig intentionally does not set `current-context`.

## Install

```sh
npm install -g kubepile
```

## Compile

```sh
kubepile compile
```

This reads `~/.config/kubepile/*.yaml` and `~/.config/kubepile/*.yml`, then writes `~/.kube/config`. If `~/.kube/config` already exists, `kubepile compile` prompts before copying it to `~/.kube/config.bak`.

Explicit command and options:

```sh
kubepile compile --config-dir ~/.config/kubepile --output ~/.kube/config
kubepile compile --backup
kubepile compile --no-backup
```

Running `kubepile` with no command prints help.

## Split

```sh
kubepile split
```

This reads `~/.kube/config` and writes one kubeconfig per context into `~/.config/kubepile`.

You can optionally override the source kubeconfig and the output kubepile
directory. These are the defaults:

```sh
kubepile split --source ~/.kube/config --output-dir ~/.config/kubepile
```

Context names that are not safe as filenames are percent-encoded when split.
