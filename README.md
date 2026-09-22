<p align="center">
  <img src="public/logo.svg" alt="FitForm logo" width="72">
</p>

<h1 align="center">FitForm</h1>

<p align="center">
  A simple browser based toolkit for working with images and PDFs.
</p>

<p align="center">
  <a href="https://fitform.slek.dev/">fitform.slek.dev</a>
</p>

## What is FitForm?

FitForm is a small, privacy focused tool for everyday image and PDF work.

You can upload an image or PDF, make the changes you need, and download the result. The processing happens in your browser, so there is no FitForm server that needs to receive your files.

FitForm also includes a Vault for keeping personal documents in your own Google Drive.

## What you can do

### Images

- Resize images to specific dimensions
- Crop images to a chosen size and position
- Reduce image file size
- Convert between JPG, PNG, WebP, BMP, and TGA
- Combine several processing steps into one workflow
- See the file size and dimensions after each step

### PDFs

- Open PDF files
- Extract a page as an image
- Prepare images for A4 printing
- Combine JPEG images into a PDF

### Vault

The Vault lets you keep FitForm documents in a dedicated folder in your own Google Drive.

FitForm uses Google's `drive.file` permission, so it does not request access to your entire Drive. Your access token is kept in memory while the page is open and is not stored in browser storage.

The Vault is optional. You can use the main image and PDF tools without connecting Google Drive.

## Privacy

FitForm is designed to work without a backend.

For the main image and PDF tools, processing happens locally in your browser. Your files are not uploaded to a FitForm server.

If you use Vault, the files are stored in your own Google Drive and Google handles the account authentication.

As with any browser application, the files you select are available to the browser while you are working with them.

## Use FitForm

Open the live site:

https://fitform.slek.dev/

No installation is required for normal use.

## Run it locally

If you want to run your own copy:

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
```

The build creates a static `dist` directory that can be hosted on services such as GitHub Pages or another static hosting provider.

## Deploying your own copy

FitForm is a static web application, so it can be hosted without a traditional backend.

If you use the Vault on another domain, you will need to create a Google OAuth client for that domain and update the Client ID used by the project.

For GitHub Pages project sites, make sure the build uses the correct base path for the repository.

## Project structure

The repository contains two main parts:

- The FitForm web application
- The `imaging` package used for image and PDF processing

The processing engine runs separately from the user interface so larger operations do not block the page while they are running.

## Limitations

- TGA is supported, but many browsers and operating systems do not preview TGA files directly.
- Some image operations involve re-encoding the image and can therefore affect quality.
- PDF rendering and large images can use a noticeable amount of memory on low-end devices.
- The Vault requires Google sign-in and an appropriately configured OAuth client when running a custom deployment.

## Development

Useful commands:

```bash
npm run dev
npm run build
npm test
npm run lint
```

## License

See the license files included in the repository and the `imaging` package for their respective terms.
