# kubepile

Have you ever tried to maintain a Kubernetes config for multiple clusters? It's
gross! It's hard to visually track which users, clusters, and contexts relate
to each other, and as you add and remove clusters your config inevitably bloats
into a mess and becomes hard to reason about.

![messy
boxes](https://raw.githubusercontent.com/reissbaker/kubepile/refs/heads/main/boxes.png)

Kubepile lets you maintain individual, per-cluster kubeconfigs in a
`~/.config/kubepile` directory, and compile them into a single, merged
kubeconfig, where each context is named after the filename.

Each `*.yaml` or `*.yml` file contributes one context. The output context name
is the source filename without its extension, so `~/.config/kubepile/eks.yaml`
becomes a context named `eks`. The compiled kubeconfig intentionally does not
set `current-context`.

## Install

```sh
npm install -g kubepile
```

## Compile

```sh
kubepile compile
```

This reads `~/.config/kubepile/*.yaml` and `~/.config/kubepile/*.yml`, then
writes `~/.kube/config`. If `~/.kube/config` already exists, `kubepile compile`
prompts before copying it to `~/.kube/config.bak`.

Explicit command and options:

```sh
kubepile compile --config-dir ~/.config/kubepile --output ~/.kube/config
kubepile compile --backup
kubepile compile --no-backup
```

Running `kubepile` with no command prints help.

## Split

Do you already have a giant unmaintainable mess of a kubeconfig? No worries!
Kubepile ships a `split` command that auto-splits your existing kubeconfig into
separate kubepile config files, and tells you on the command line if you have
unsplittable configs due to impossible settings from config drift — and which
keys exactly are the problem, so you can clean up your config before splitting
it.

To split your config, run:

```sh
kubepile split
```

This reads `~/.kube/config` and writes one kubeconfig per context into
`~/.config/kubepile`.

If there are errors in your kubeconfig that prevent splitting, it'll tell you
what they are.

You can optionally override the source kubeconfig and the output kubepile
directory. These are the defaults:

```sh
kubepile split --source ~/.kube/config --output-dir ~/.config/kubepile
```

Context names that are not safe as filenames are percent-encoded when split.
