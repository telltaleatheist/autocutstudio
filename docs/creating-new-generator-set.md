# Creating a New Generator Set and Master

This document explains how to create a new compound generator set (like the Shorts/Vertical format) for AutoCutStudio. This process was used to create the YouTube Shorts (9:16 vertical) generators.

## Overview

A complete generator set consists of:
1. **CAM Generator** - Camera-only compound (solo + dual modes)
2. **SSB Generator** - Screen Share + Camera compound (solo + dual modes)
3. **Hybrid Generator** - Auto-toggles between solo/DC based on cam2 activity
4. **Master Project Generator** - Combines compounds into a final timeline

## Step 1: Create Template Files in Final Cut Pro

First, manually create template projects in Final Cut Pro that show exactly how the final output should look.

### Required Templates:
- `template {format} cam solo.fcpxml` - Single camera layout
- `template {format} cam dc.fcpxml` - Dual camera layout
- `template {format} ssb solo.fcpxml` - Screen + single camera
- `template {format} ssb dc.fcpxml` - Screen + dual cameras

### Template Requirements:
- Use a placeholder video (like `template-no-borders.mov`) as the source
- Apply all crops, transforms, and scales to achieve desired layout
- Include any border/overlay assets with their transforms
- Export as FCPXML (File → Export XML)

## Step 2: Extract Transform Values from Templates

Open each template FCPXML and extract the transform values:

### Key Elements to Extract:

```xml
<!-- Crop values -->
<adjust-crop mode="trim">
    <trim-rect left="X" top="Y" right="Z" bottom="W"/>
</adjust-crop>

<!-- Position and scale -->
<adjust-transform position="X Y" scale="S S"/>
```

### Document the values in a table:

| Layout | Element | Crop (L,T,R,B) | Position (X,Y) | Scale | Lane |
|--------|---------|----------------|----------------|-------|------|
| CAM Solo | cam1 | 0, 50.04, 88.89, 0 | 89.2, 50.3 | 6.36 | 1 |
| CAM DC | cam1 | 0, 50.04, 88.89, 0 | 46.2, -0.1 | 3.2 | 1 |
| CAM DC | cam2 | 88.89, 0, 0, 50.04 | -43.2, -0.5 | 3.2 | 2 |
| SSB Solo | screen | 0, 0, 88.89, 50.04 | 89.4, -50.4 | 6.36 | 1 |
| ... | ... | ... | ... | ... | ... |

**Note:** Crop values map to `[left, top, right, bottom]` in the config.

## Step 3: Update Configuration Files

You must update **BOTH** config files:
- `/Volumes/Callisto/Projects/AutoCutStudioApp/config/autostudio_config.yaml` (project)
- `~/Library/Application Support/AutoCutStudio/config/autostudio_config.yaml` (user - used at runtime!)

### 3.1 Add Border Assets (if needed)

```yaml
paths:
  assets:
    borders:
      # Add new border assets
      your_format:
        border: /path/to/your/border.png
```

### 3.2 Add Video Format Settings

```yaml
# Add after existing 'video:' section
video_yourformat:
  frame_duration: 1001/30000s
  width: 1080      # Your output width
  height: 1920     # Your output height
  color_space: 1-1-1 (Rec. 709)
  tcFormat: NDF
  audioLayout: stereo
  audioRate: 48k
```

### 3.3 Add Layout Configurations

```yaml
layouts:
  yourformat_cam:
    solo:
      camera:
        lane: 1
        crop:
          - 0        # left
          - 50.0412  # top
          - 88.8889  # right
          - 0        # bottom
        position:
          - 89.2019  # X
          - 50.291   # Y
        scale: 6.3576
      audio_sources:
        - mic1
        - mic2
        # ... other audio sources
    dual:
      cam1:
        lane: 1
        crop: [0, 50.0412, 88.8889, 0]
        position: [46.1833, -0.103782]
        scale: 3.2
      cam2:
        lane: 2
        crop: [88.8889, 0, 0, 50.0412]
        position: [-43.1878, -0.498011]
        scale: 3.2
      audio_sources:
        - mic1
        - mic2
        # ...

  yourformat_ssb:
    solo:
      screen:
        lane: 1
        crop: [0, 0, 88.8889, 50.0412]
        position: [89.3698, -50.4281]
        scale: 6.3619
      camera:
        lane: 2
        crop: [0, 50.0412, 88.8889, 0]
        position: [24.4792, -18.2292]
        scale: 1.75
        border: yourformat.border  # Reference to border asset
        border_position: [0, 4.42708]
        border_scale: 1.4
      audio_sources:
        - screen
        - game
        - bluetooth
    dual:
      screen:
        # ... same as solo
      cam1:
        lane: 2
        crop: [0, 50.0412, 88.8889, 0]
        position: [5.52029, -17.6981]
        scale: 1.15
        border: yourformat.border
        border_position: [-10.6878, -2.73181]
        border_scale: 0.92
      cam2:
        lane: 4
        crop: [88.8889, 0, 0, 50.0412]
        position: [-5.74915, -48.3457]
        scale: 1.15
        border: yourformat.border
        border_position: [10.3731, -15.2241]
        border_scale: 0.92
      audio_sources:
        - screen
        - game
        - bluetooth
```

### 3.4 Add Config Property (core/config.py)

```python
@property
def video_yourformat_settings(self) -> Dict[str, Any]:
    return self.get('video_yourformat', {
        'width': 1080,
        'height': 1920,
        'frame_duration': '1001/30000s',
        'color_space': '1-1-1 (Rec. 709)',
        'tcFormat': 'NDF',
        'audioLayout': 'stereo',
        'audioRate': '48k'
    })
```

## Step 4: Create the CAM Generator

Copy `core/compound_generators/shorts_cam_generator.py` as a template.

### Key modifications:

1. **Class name**: `YourFormatCamGenerator`

2. **Format ID**: Use unique format IDs
   ```python
   format_id = 'r1_yourformat_cam'
   ```

3. **Video settings**: Use your config
   ```python
   video_settings = self.config.video_yourformat_settings
   ```

4. **Layout config**: Reference your layout
   ```python
   layout_config = self.config.get_layout_config('yourformat_cam', mode)
   ```

5. **Compound ID**: Unique IDs for solo vs dual
   ```python
   cam_compound_id = "dc_yourformat_cam_compound" if mode == "dual" else "yourformat_cam_compound"
   ```

6. **Handle both modes**: The generator must handle both `camera` config (solo) and `cam1`/`cam2` configs (dual):
   ```python
   camera_config = layout_config.get('camera', {})  # Solo mode
   cam1_config = layout_config.get('cam1', {})      # Dual mode
   cam2_config = layout_config.get('cam2', {})      # Dual mode

   if camera_config:
       # Solo mode - single camera
       # Read crop/position/scale from camera_config
   elif cam1_config:
       # Dual mode - two cameras
       # Read from cam1_config and cam2_config
   ```

7. **Output filename**:
   ```python
   suffix = "_DC_YOURFORMAT_CAM.fcpxml" if mode == "dual" else "_YOURFORMAT_CAM.fcpxml"
   ```

## Step 5: Create the SSB Generator

Copy `core/compound_generators/shorts_ssb_generator.py` as a template.

### Key modifications:

Same as CAM generator, plus:

1. **Screen handling**: SSB includes screen video
   ```python
   screen_config = layout_config.get('screen', {})
   if screen_config:
       screen_transforms = {
           'crop': screen_config.get('crop', [...]),
           'crop_mode': 'trim',
           'transform': {
               'position': screen_config.get('position', [...]),
               'scale': screen_config.get('scale', X.X)
           }
       }
   ```

2. **Border handling**: Apply border transforms from config
   ```python
   if 'border' in camera_config:
       border_position = camera_config.get('border_position', [0, 0])
       border_scale = camera_config.get('border_scale', 1.0)
       border_transforms = {
           'crop': None,
           'crop_mode': None,
           'transform': {
               'position': border_position,
               'scale': border_scale
           }
       }
   ```

## Step 6: Create the Hybrid Generator

Copy `core/compound_generators/shorts_hybrid_generator.py` as a template.

### Purpose:
The hybrid generator takes the DC (dual camera) compounds and creates new compounds that auto-toggle between solo and DC layouts based on cam2 activity detection.

### Key concepts:

1. **Segment detection**: Uses `CameraDetector` to find when cam2 is active
   ```python
   segments = self.camera_detector.detect_segments(cut_master_video_path, camera_region='top_right')
   # Returns: [(start_time, end_time, 'solo'|'dc'), ...]
   ```

2. **Video layer manipulation**: For each segment:
   - **SOLO segments**: Disable cam2 video, reset cam1 transforms
   - **DC segments**: Keep all layers enabled

3. **Filename pattern**: Must match DC compound filenames
   ```python
   output_path = Path(output_dir) / Path(dc_cam_path).name.replace('DC_YOURFORMAT_CAM', 'YOURFORMAT_HYBRID_CAM')
   ```

## Step 7: Create the Master Project Generator

Copy `core/compound_generators/shorts_master_project_generator.py` as a template.

### Key modifications:

1. **Remove GS if not needed**: Shorts don't include GS (Game Share), so all GS-related code was removed. If your format includes GS, keep it.

2. **Video format**: Use your format dimensions
   ```python
   timeline_format.set('width', '1080')
   timeline_format.set('height', '1920')
   ```

3. **Lane structure**: Define which compounds go on which lanes
   ```python
   # Lane 0: CAM (main spine)
   # Lane 1: SSB video
   # Lane -1: CAM audio
   # Lane -2: SSB audio
   ```

4. **Output filename**:
   ```python
   output_filename = f"{original_name}_YOURFORMAT.fcpxml"
   ```

## Step 8: Integrate with Workflow

Edit `cli/electron_workflow.py`:

### 8.1 Add imports:
```python
from core.compound_generators.yourformat_cam_generator import YourFormatCamGenerator
from core.compound_generators.yourformat_ssb_generator import YourFormatSSBGenerator
from core.compound_generators.yourformat_hybrid_generator import YourFormatHybridGenerator
from core.compound_generators.yourformat_master_project_generator import YourFormatMasterProjectGenerator
```

### 8.2 Add generation code:
```python
# Generate YourFormat compounds and master project
yourformat_cam_solo_path = None
yourformat_ssb_solo_path = None
yourformat_cam_dual_path = None
yourformat_ssb_dual_path = None
yourformat_hybrid_cam_path = None
yourformat_hybrid_ssb_path = None

# Generate Solo CAM
try:
    yourformat_cam_gen = YourFormatCamGenerator(config)
    yourformat_cam_solo_path = yourformat_cam_gen.generate_yourformat_cam_compound(
        compound_xml, cam_audio_sources, 'solo', None, False, video_sources,
        use_downloaded_stream=use_downloaded_stream
    )
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)

# ... repeat for SSB Solo, CAM Dual, SSB Dual ...

# Generate Hybrid compounds
if yourformat_cam_dual_path and yourformat_ssb_dual_path:
    try:
        yourformat_hybrid_gen = YourFormatHybridGenerator(config)
        yourformat_hybrid_cam_path, yourformat_hybrid_ssb_path = yourformat_hybrid_gen.generate_yourformat_hybrid_compounds(
            yourformat_cam_dual_path, yourformat_ssb_dual_path,
            cut_master_video, output_dir,
            use_downloaded_stream=use_downloaded_stream
        )
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)

# Generate Master Project
if yourformat_hybrid_cam_path and yourformat_hybrid_ssb_path:
    try:
        yourformat_master_gen = YourFormatMasterProjectGenerator(config)
        master_yourformat_paths = yourformat_master_gen.generate_yourformat_master_project(
            yourformat_hybrid_cam_path, yourformat_hybrid_ssb_path, original_name
        )
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
```

## Common Pitfalls

1. **Forgetting the user config**: The workflow uses `~/Library/Application Support/AutoCutStudio/config/autostudio_config.yaml`, not the project config. Always update both!

2. **Wrong lane numbers**: Lane numbers must match between config and generator code.

3. **Solo vs Dual config keys**: Solo mode uses `camera`, dual mode uses `cam1`/`cam2`. Make sure generators check for both.

4. **Compound ID collisions**: Each compound needs a unique ID. Solo and dual modes need different IDs.

5. **Filename patterns**: Hybrid generator must use the correct replacement pattern to find DC files:
   ```python
   .replace('DC_YOURFORMAT_CAM', 'YOURFORMAT_HYBRID_CAM')
   ```

6. **GS references in master**: If your format doesn't include GS, remove all GS-related code from the master project generator.

## Testing

1. Run the workflow with a test video
2. Import generated FCPXMLs into Final Cut Pro
3. Verify:
   - Video elements are positioned correctly
   - Crops are applied correctly
   - Borders have correct position/scale
   - Audio is on correct lanes
   - Solo/DC toggling works in hybrid compounds

## File Checklist

When creating a new generator set, you'll create/modify these files:

### New Files:
- [ ] `core/compound_generators/yourformat_cam_generator.py`
- [ ] `core/compound_generators/yourformat_ssb_generator.py`
- [ ] `core/compound_generators/yourformat_hybrid_generator.py`
- [ ] `core/compound_generators/yourformat_master_project_generator.py`

### Modified Files:
- [ ] `config/autostudio_config.yaml` (project)
- [ ] `~/Library/Application Support/AutoCutStudio/config/autostudio_config.yaml` (user)
- [ ] `core/config.py` (add video_yourformat_settings property)
- [ ] `cli/electron_workflow.py` (add imports and generation code)

## Example: Shorts Implementation

The YouTube Shorts (vertical 9:16) implementation serves as the reference:

- **Generators**: `shorts_cam_generator.py`, `shorts_ssb_generator.py`, `shorts_hybrid_generator.py`, `shorts_master_project_generator.py`
- **Config sections**: `video_shorts`, `shorts_cam`, `shorts_ssb`
- **Format ID prefix**: `r1_shorts_*`
- **Compound IDs**: `shorts_cam_compound`, `dc_shorts_cam_compound`, etc.
- **Output files**: `*_SHORTS_CAM.fcpxml`, `*_DC_SHORTS_CAM.fcpxml`, `*_SHORTS_HYBRID_CAM.fcpxml`, `*_SHORTS.fcpxml`
