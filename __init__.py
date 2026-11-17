
import os
import hashlib

import folder_paths
import nodes
from aiohttp import web
from server import PromptServer


EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp",
    ".bmp", ".gif", ".tif", ".tiff"
}


def input_root():
    return os.path.realpath(
        folder_paths.get_input_directory()
    )


def safe_path(relative):
    root = input_root()
    relative = str(relative).replace("\\", "/")

    if relative in ("", "."):
        return root

    path = os.path.realpath(
        os.path.join(root, relative)
    )

    if os.path.commonpath([root, path]) != root:
        raise ValueError("Path outside input directory")

    return path


def list_folders():
    root = input_root()
    result = ["."]

    for current, dirs, files in os.walk(root):
        dirs[:] = sorted(
            d for d in dirs
            if not os.path.islink(os.path.join(current, d))
        )

        if current != root:
            relative = os.path.relpath(current, root)
            result.append(relative.replace("\\", "/"))

    return sorted(result)


def list_images(folder):
    path = safe_path(folder)

    if not os.path.isdir(path):
        return []

    images = []

    for name in os.listdir(path):
        full = os.path.join(path, name)

        if (
            os.path.isfile(full)
            and os.path.splitext(name)[1].lower()
            in EXTENSIONS
        ):
            images.append(name)

    return sorted(images, key=str.lower)


@PromptServer.instance.routes.get(
    "/load_image_by_folder/folders"
)
async def get_folders(request):
    return web.json_response({
        "folders": list_folders()
    })


@PromptServer.instance.routes.get(
    "/load_image_by_folder/images"
)
async def get_images(request):
    folder = request.query.get("folder", ".")

    try:
        images = list_images(folder)
        return web.json_response({
            "images": images
        })
    except (ValueError, OSError):
        return web.json_response(
            {"error": "Invalid folder"},
            status=400
        )


class LoadImageByFolder:

    @classmethod
    def INPUT_TYPES(cls):
        folders = list_folders()

        return {
            "required": {
                "folder": (folders,),
                "image": (
                    ["-- Select Image --"],
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    FUNCTION = "load_image"
    CATEGORY = "image"

    def load_image(self, folder, image):
        if not image:
            raise ValueError("Please select an image")

        if (
            os.path.basename(image) != image
            or image in (".", "..")
        ):
            raise ValueError("Invalid image filename")

        relative = os.path.normpath(
            os.path.join(folder, image)
        )
        full = safe_path(relative)

        if not os.path.isfile(full):
            raise FileNotFoundError(full)

        # Reuse ComfyUI's native LoadImage implementation.
        return nodes.LoadImage().load_image(
            relative.replace("\\", "/")
        )

    @classmethod
    def IS_CHANGED(cls, folder, image):
        if not image:
            return ""

        try:
            full = safe_path(
                os.path.join(folder, image)
            )

            with open(full, "rb") as f:
                return hashlib.sha256(
                    f.read()
                ).hexdigest()
        except (OSError, ValueError):
            return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, folder, image):
        try:
            if not image:
                return "No image selected"

            if os.path.basename(image) != image:
                return "Invalid filename"

            full = safe_path(
                os.path.join(folder, image)
            )

            if not os.path.isfile(full):
                return "Image not found"

            return True

        except (OSError, ValueError) as e:
            return str(e)


NODE_CLASS_MAPPINGS = {
    "LoadImageByFolder": LoadImageByFolder
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadImageByFolder": "Load Image By Folder"
}

WEB_DIRECTORY = "./web"
