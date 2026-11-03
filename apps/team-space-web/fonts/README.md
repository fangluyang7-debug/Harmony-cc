# Dashboard UI font

`harmony-ui.woff` is a subset of Noto Sans SC, exposed through the CSS alias
`Harmony UI`. It includes printable ASCII and the characters in the dashboard
sources, with the variable weight axis preserved. No network font service is used.
Characters outside the subset (for example, user-defined device names) fall back
to locally installed Noto Sans SC / Segoe UI / Microsoft YaHei.

The source was the installed `NotoSansSC-VF.ttf` (version and SHA-256 in
`font-source.json`). Copyright and license records remain in the font.
The SIL Open Font License 1.1 is included in `OFL.txt`, copied from
[the Google Fonts Noto Sans SC distribution](https://github.com/google/fonts/tree/main/ofl/notosanssc).
The font is redistributed under that license; application code keeps its own license.

To rebuild after changing dashboard copy, supply a licensed Noto Sans SC variable
TTF to the build-only script (requires Python 3 and fontTools):

```powershell
py -3.13 scripts/build-dashboard-font.py C:/Windows/Fonts/NotoSansSC-VF.ttf
```

The script writes the WOFF and source metadata. The source TTF and Python packages
are not required when serving the page. Check glyph coverage and visual appearance
when rebuilding with a different font release.
