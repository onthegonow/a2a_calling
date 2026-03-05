# macOS Signing & Notarization Setup (A2A-94)

This document describes the required Apple credentials for signed, notarized macOS release artifacts.

## Prerequisites

- Apple Developer Program membership (active)
- Developer ID Application certificate for your team
- Access to GitHub repository secrets for this project

## 1) Create a Developer ID Application certificate

1. Open Apple Developer portal → Certificates, IDs & Profiles.
2. Create a new **Developer ID Application** certificate.
3. Export the certificate + private key from Keychain as `.p12`.
4. Protect the `.p12` export with a strong password.

## 2) Create GitHub Actions secrets

Upload the following repository secrets:

- `APPLE_CERTIFICATE`: base64-encoded `.p12` archive
- `APPLE_CERTIFICATE_PASSWORD`: password used for `.p12` export
- `APPLE_SIGNING_IDENTITY`: exact certificate identity string
- `APPLE_ID`: Apple account email used for notarization
- `APPLE_PASSWORD`: app-specific password for notarization
- `APPLE_TEAM_ID`: Apple Developer Team ID

Example identity format:

```text
Developer ID Application: Your Name (TEAMID)
```

## 3) Validate the release output

The macOS build workflow verifies all three checks before publishing artifacts:

- `codesign --verify --deep --strict` on the `.app`
- `spctl --assess --type execute` on the `.app`
- `xcrun stapler validate` on the `.dmg`

A release is considered valid only when all checks pass.

## Security notes

- Never commit `.p12`, `.cer`, or private key material.
- Keep certificate exports in a local, encrypted store only.
- Rotate Apple app-specific passwords if they are exposed.
