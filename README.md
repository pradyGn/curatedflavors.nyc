# curatedflavors.nyc

The published static site for **https://curatedflavors.nyc**, the marketing page for
the [NYC Eats](https://apps.apple.com/us/app/nyc-eats/id6768158917) iOS app.

## Do not edit this repository by hand

Everything here except this README is generated. It is a mirror of `website/public/`
in the private `nyc-foods-reddit` monorepo, published by `tools/publish_website.py`.
A hand edit will be silently overwritten by the next publish.

To change the site, change it there and publish:

```bash
python3 tools/export_website_data.py   # refresh the data snapshot
python3 tools/publish_website.py       # mirror website/public/ into this repo
```

GitHub Pages serves this repository from `main` at the repository root.
