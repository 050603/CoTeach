# CoTeach OMML to MathML converter

This private workspace package is a security-maintained fork of
`omml2mathml@1.3.0` (Apache-2.0).

The upstream package depended on `get-dom@9`, which pulled the retired
`jsdom@9`, `request`, and `form-data@2` chain into production. This fork reuses
the DOM implementation of the parsed OMML document and therefore requires no
HTML DOM shim. Conversion behavior remains otherwise unchanged.
