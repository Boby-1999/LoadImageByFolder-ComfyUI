
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "LoadImageByFolder.DynamicSelector",

    async nodeCreated(node) {
        if (node.comfyClass !== "LoadImageByFolder") {
            return;
        }

        const folderWidget = node.widgets?.find(
            w => w.name === "folder"
        );

        const imageWidget = node.widgets?.find(
            w => w.name === "image"
        );

        if (!folderWidget || !imageWidget) {
            console.warn(
                "[LoadImageByFolder] Widgets not found"
            );
            return;
        }

        let requestId = 0;

        async function fetchJSON(url) {
            const response = await api.fetchApi(url);

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}`
                );
            }

            return await response.json();
        }

        function setOptions(widget, values, preferred) {
            widget.options.values = values;

            if (values.includes(preferred)) {
                widget.value = preferred;
            } else {
                widget.value = values[0] ?? "";
            }

            node.setDirtyCanvas(true, true);
        }

        function updatePreview() {
            const folder = folderWidget.value || ".";
            const filename = imageWidget.value;

            if (
                !filename ||
                filename === "-- Select Image --"
            ) {
                node.imgs = [];
                node.setDirtyCanvas(true, true);
                return;
            }

            const params = new URLSearchParams({
                filename: filename,
                type: "input",
                subfolder: folder === "." ? "" : folder,
                t: Date.now().toString()
            });

            const img = new Image();

            img.onload = () => {
                node.imgs = [img];
                node.setDirtyCanvas(true, true);
            };

            img.onerror = () => {
                console.warn(
                    "[LoadImageByFolder] Preview failed:",
                    filename
                );

                node.imgs = [];
                node.setDirtyCanvas(true, true);
            };

            img.src = api.apiURL(
                "/view?" + params.toString()
            );
        }

        async function refreshImages(preferred = null) {
            const currentRequest = ++requestId;
            const folder = folderWidget.value || ".";

            try {
                const data = await fetchJSON(
                    "/load_image_by_folder/images?folder=" +
                    encodeURIComponent(folder)
                );

                if (currentRequest !== requestId) {
                    return;
                }

                const images = data.images || [];
                const previous =
                preferred ?? imageWidget.value;

                setOptions(
                    imageWidget,
                    images.length
                    ? images
                    : ["-- Select Image --"],
                    previous
                );

                updatePreview();
            } catch (error) {
                console.error(
                    "[LoadImageByFolder] Image refresh failed",
                    error
                );
            }
        }

        async function refreshFolders() {
            const previousFolder = folderWidget.value;
            const previousImage = imageWidget.value;

            try {
                const data = await fetchJSON(
                    "/load_image_by_folder/folders"
                );

                setOptions(
                    folderWidget,
                    data.folders || ["."],
                    previousFolder
                );

                await refreshImages(previousImage);
            } catch (error) {
                console.error(
                    "[LoadImageByFolder] Folder refresh failed",
                    error
                );
            }
        }

        const originalFolderCallback =
        folderWidget.callback;

        folderWidget.callback = function(value) {
            originalFolderCallback?.call(this, value);

            // When folder changes, choose first image.
            refreshImages("");
        };

        const originalImageCallback =
        imageWidget.callback;

        imageWidget.callback = function(value) {
            originalImageCallback?.call(this, value);
            updatePreview();
        };

        // The folder is captured when the upload starts, so changing the
        // selector while it is in progress cannot redirect the file.
        let uploading = false;
        async function uploadImage(file, folder = folderWidget.value || ".") {
            if (uploading) {
                alert("An image upload is already in progress.");
                return;
            }
            if (!/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file.name)) {
                alert("Please choose a supported image file.");
                return;
            }

            const body = new FormData();
            body.append("image", file);
            body.append("type", "input");
            body.append("subfolder", folder === "." ? "" : folder);
            uploading = true;

            try {
                const response = await api.fetchApi("/upload/image", {
                    method: "POST",
                    body
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
                }
                const result = await response.json();
                if (!result.name) {
                    throw new Error("The server did not return a filename.");
                }
                if ((folderWidget.value || ".") === folder) {
                    await refreshImages(result.name);
                }
            } catch (error) {
                console.error("[LoadImageByFolder] Upload failed", error);
                alert(`Image upload failed: ${error.message || error}`);
            } finally {
                uploading = false;
            }
        }

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = ".png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff";
        fileInput.style.display = "none";
        document.body.appendChild(fileInput);
        fileInput.addEventListener("change", () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (file) uploadImage(file);
        });

        node.addWidget("button", "choose file to upload", null, () => {
            fileInput.click();
        });

        const originalDragOver = node.onDragOver;
        node.onDragOver = function(event) {
            const transfer = event.dataTransfer;
            if (Array.from(transfer?.items || []).some(item => item.kind === "file") ||
                Array.from(transfer?.types || []).some(type =>
                    type === "application/x-comfy-asset-info" || type === "text/uri-list")) {
                return true;
            }
            return originalDragOver?.call(this, event) || false;
        };

        const originalDragDrop = node.onDragDrop;
        node.onDragDrop = async function(event) {
            const file = event.dataTransfer?.files?.[0];
            if (file) {
                await uploadImage(file);
                return true;
            }
            const transfer = event.dataTransfer;
            const assetData = transfer?.getData("application/x-comfy-asset-info");
            const uriList = transfer?.getData("text/uri-list");
            if (assetData || uriList) {
                const folder = folderWidget.value || ".";
                try {
                    let asset = {};
                    if (assetData) asset = JSON.parse(assetData);
                    const uri = uriList?.split(/\r?\n/).find(line => line && !line.startsWith("#"));
                    let url;
                    if (uri) {
                        url = new URL(uri, location.href);
                    } else if (asset.filename && ["input", "output", "temp"].includes(asset.type)) {
                        const params = new URLSearchParams({
                            filename: asset.filename,
                            subfolder: asset.subfolder || "",
                            type: asset.type
                        });
                        url = new URL(api.apiURL("/view?") + params, location.href);
                    } else {
                        throw new Error("The asset has no original file URL.");
                    }
                    if (url.origin !== location.origin) {
                        throw new Error("Only assets from this ComfyUI server are supported.");
                    }
                    const filename = (asset.filename || url.searchParams.get("filename") ||
                        decodeURIComponent(url.pathname.split("/").pop())).split(/[\\/]/).pop();
                    if (!filename || !/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(filename)) {
                        throw new Error("Please drop a supported image asset.");
                    }
                    const response = await fetch(url, { redirect: "error" });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const blob = await response.blob();
                    await uploadImage(new File([blob], filename, { type: blob.type }), folder);
                } catch (error) {
                    console.error("[LoadImageByFolder] Asset drop failed", error);
                    alert(`Asset drop failed: ${error.message || error}`);
                }
                return true;
            }
            return (await originalDragDrop?.call(this, event)) || false;
        };

        const originalRemoved = node.onRemoved;
        node.onRemoved = function(...args) {
            fileInput.remove();
            return originalRemoved?.apply(this, args);
        };

        node.addWidget(
            "button",
            "Refresh folders / images",
            null,
            () => refreshFolders()
        );

        // Restore saved workflow selections.
        const originalConfigure = node.onConfigure;

        node.onConfigure = function(info) {
            const result =
            originalConfigure?.call(this, info);

            const savedFolder = folderWidget.value;
            const savedImage = imageWidget.value;

            Promise.resolve().then(async () => {
                try {
                    const data = await fetchJSON(
                        "/load_image_by_folder/folders"
                    );

                    setOptions(
                        folderWidget,
                        data.folders || ["."],
                        savedFolder
                    );

                    await refreshImages(savedImage);
                } catch (error) {
                    console.error(
                        "[LoadImageByFolder] Restore failed",
                        error
                    );
                }
            });

            return result;
        };

        await refreshFolders();
    }
});
