# Unreleased Relay MCP feasibility demo

## Added

- Fixed file/image/HTML feasibility demo over the existing authorized Relay MCP connection: an authored List/Cards preview and one original-byte PNG export with integrity metadata and a 15-minute expiry.
- Relay transport groundwork for typed resource links, resource discovery and authorized resource reads. The two demo tools accept no Session, directory, file path or generated HTML.

## Limitations

This is not the completed general artifact pipeline. Arbitrary Session-scoped artifacts, PDF export and complete skill/proposal bundles are not implemented by the demo. Actual-chat interactive UI rendering and native-file delivery remain unverified and depend on the host's capabilities. A resource link or inline image is not proof of a downloadable native attachment.
