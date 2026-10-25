# Desktop cwd compatibility

Some installed prompt plugins still reference `{{cwd}}` after DSH Desktop has moved the working directory into a runtime context instead of a prompt variable. This optional standalone bundle supplies a missing `cwd` value during prompt assembly. It uses the agent's working-directory service, then the session header, and explicitly labels an unavailable directory. Existing prompt variable values take precedence.

This package is independent of companion memory. Its local source is linked in the Desktop profile so replacing another plugin does not remove this fix. The installer prepares a reviewed profile change and backs up the profile package before applying:

Version 1.0.1 uses Cordis 4's service-name array (`inject = ['systemPrompt']`). The earlier `required`/`optional` map syntax is not supported by this Desktop loader and leaves the plugin pending. Verification with the Desktop's actual Cordis 4.0.5 confirms activation, event dispatch, strict interpolation, directory changes and unload cleanup. The installed copy can be checked with `node scripts/verify-desktop-cwd-runtime.mjs --installed` after extracting the host test dependencies into `artifacts/desktop-cwd-runtime/`.

```sh
node scripts/install-desktop-cwd-compat.mjs
node scripts/install-desktop-cwd-compat.mjs --apply
```

The installer currently targets the local Windows Desktop profile under `C:/Users/33544/.dsh/profiles/desktop`. Restart Desktop to load the new bundle. To remove it, remove `dsh-desktop-cwd-compat` from that profile's dependencies and bundles, then restart. The original installed plugins need no edits.
