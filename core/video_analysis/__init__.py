# core/video_analysis/__init__.py

# Make CameraDetector optional - only import if numpy is available
try:
    from .camera_detector import CameraDetector
    __all__ = ['CameraDetector']
except ImportError as e:
    # numpy or other dependencies not available
    # This is okay - CameraDetector is optional
    CameraDetector = None
    __all__ = []
