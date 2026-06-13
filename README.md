# Kubepile

Have you ever tried to maintain a Kubernetes config for multiple clusters, and
multiple Kubernetes providers? It's gross! It's hard to visually track which
users, clusters, and contexts relate to each other, and as you add and remove
clusters your config inevitably bloats into a mess and becomes hard to reason
about.

![messy
boxes](https://raw.githubusercontent.com/reissbaker/kubepile/refs/heads/main/boxes.png)

Kubepile lets you maintain individual, per-provider kubeconfigs in a
`~/.config/kubepile` directory, and compile them into a single, merged
kubeconfig.

Each `*.yaml` file is a normal kubeconfig. You can paste in kubeconfigs from
providers without converting them to a kubepile-specific schema. During
`compile`, kubepile reads every file and merges its `clusters`, `users`, and
`contexts` directly into the generated kubeconfig. It does not rename anything
based on the filename.

Kubepile automatically ensures the following:

- No kubepile files set a `current-context`.
- No cluster, user, or context names clash.

If a new file is added that clashes or sets a `current-context`, kubepile will
intentionally fail compilation with a helpful message explaining which file
broke the kubepile rules.

Kubepile will never set a `current-context`, out of the design belief that
`current-context` is a dangerous footgun in multi-cluster setups.

## Install

```sh
npm install -g kubepile
```

## Compile

```sh
kubepile compile
```

This reads `~/.config/kubepile/*.yaml`, then writes `~/.kube/config`. If
`~/.kube/config` already exists, `kubepile compile` prompts before copying it to
`~/.kube/config.bak`.

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
separate per-context kubepile config files, and tells you on the command line
if you have unsplittable configs due to impossible settings from config drift —
and which keys exactly are the problem, so you can clean up your config before
splitting it.

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
