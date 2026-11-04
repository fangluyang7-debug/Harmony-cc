"""One inference per process. Process exit confirms worker settlement."""
import base64
import json
import os
import sys

cuda = "--cuda" in sys.argv
os.environ["IMAGE_WORKER_DEVICE"] = "cuda:0" if cuda else "cpu"
from app.main import ImagePayload, embed_image_v2, torch

if __name__ == "__main__":
    torch.set_num_threads(1)
    raw = sys.stdin.buffer.read(8388609)
    if not 0 < len(raw) <= 8388608:
        raise ValueError("IMAGE_SIZE_LIMIT")
    result = embed_image_v2(ImagePayload(imageBase64=base64.b64encode(raw).decode("ascii")))
    if cuda:
        from app.main import registry
        if not torch.cuda.is_available() or next(registry.embedding_model.parameters()).device.type != "cuda":
            raise RuntimeError("CUDA_MODEL_REQUIRED")
        torch.cuda.synchronize()
        result["backend"] = "CUDA"
        if "--probe" in sys.argv:
            props = torch.cuda.get_device_properties(0)
            result = {"cudaAvailable": True, "backend": "CUDA", "modelLoaded": True,
                      "modelHash": result["model"]["weightsHash"], "model": result["model"],
                      "uuid": str(props.uuid), "totalBytes": props.total_memory}
    sys.stdout.write(json.dumps(result, separators=(",", ":"), allow_nan=False))
