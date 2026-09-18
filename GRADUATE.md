# Moving this directory into its own repository

Everything in here is already a standalone repository: `package.json` declares the workspaces, `npm install && npm test` works from this directory with its own `node_modules`, and nothing references the `smartbox-x` monorepo it was started in. What is left is the GitHub side, which needs one thing this session could not do.

**Why it is not done.** Creating a repository needs `administration: write`, and the GitHub App this session authenticates as does not have it (`403 Resource not accessible by integration`). That is a permission to grant, not a bug to work around.

## The three commands

Create an **empty** repository first — no README, no `.gitignore`, no licence, or the first push will conflict — at `https://github.com/new`, named `plumbline`, owned by `discoverclick-ai`.

Then, from a clone of `smartbox-x` with this branch checked out:

```bash
# 1. Lift plumbline/ out with its history. Produces a branch whose commits
#    contain only this directory's files, rooted at the repository root.
git subtree split --prefix=plumbline -b plumbline-standalone

# 2. Point at the new repository and push that branch as main.
git remote add plumbline git@github.com:discoverclick-ai/plumbline.git
git push plumbline plumbline-standalone:main

# 3. Work in the new repository from here on.
git clone git@github.com:discoverclick-ai/plumbline.git
cd plumbline && npm install && npm test
```

`git subtree split` rewrites the three commits that touched `plumbline/` so their paths start at the repository root, and drops every commit that did not. The result is a real history — `git log` and `git blame` both work, and the reasoning in each commit message survives — rather than a single "initial commit" dump.

## Then, in the old repository

Delete the directory and commit:

```bash
git rm -r plumbline
npm install   # drops the last plumbline entries from package-lock.json
git commit -am "chore: plumbline graduated to its own repository"
```

`smartbox-x` is already decoupled: `plumbline/` is out of its workspaces, its build, and its test runner, and its suites pass without it. The directory is inert until it is removed.

## What the new repository is still missing

**A role-provisioning script.** Migration `0006_rls.sql` creates `plumbline_app` as `NOLOGIN`, because issuing a credential is a deployment decision and no password belongs in a migration file. Every deployment therefore has to grant that role to a login user by hand. `smartbox-x` solves this with a `provision:app-role` script that connects as the new role, confirms `rolbypassrls` is false, confirms a context-free read returns zero rows, and refuses to write a connection string that has not demonstrated confinement. Port it before the first real deployment: a credential that quietly bypasses row-level security is worse than no credential, because it looks like it works.

**A recorded eval baseline.** `eval/` has no `baseline.json` yet, because nothing has been scored against a real model. Run `npm run eval:capture -- --save-baseline` once with a key (roughly a dollar for the 24 cases), and `--check` becomes a regression gate CI can enforce.
