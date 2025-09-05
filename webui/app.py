# webui/app.py

from flask import Flask, render_template, request, jsonify, send_file, send_from_directory
import os
import sys
import json
from pathlib import Path
import tempfile
import threading
import uuid
from datetime import datetime
import math
import logging
import re
import traceback

# Add parent directory to path to import core modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.config import AutoCutStudioConfig
from core.compound_generators.cam_generator import CamGenerator
from core.compound_generators.gs_generator import GSGenerator
from core.compound_generators.ssb_generator import SSBGenerator
from core.compound_generators.dc_cam_generator import DCCamGenerator
from core.compound_generators.dc_gs_generator import DCGSGenerator
from core.compound_generators.dc_ssb_generator import DCSSBGenerator
from core.compound_generators.master_project_generator import MasterProjectGenerator
from core.audio_processor import AudioProcessor
from core.editors.auto_editor import AutoEditor
from core.xml_utils import FCPXMLUtils

app = Flask(__name__)
app.secret_key = 'your-secret-key-here'
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

# Global job tracking
active_jobs = {}

class ProcessingJob:
    def __init__(self, job_id):
        self.id = job_id
        self.status = 'starting'
        self.progress = 0
        self.message = 'Initializing...'
        self.error = None
        self.results = []
        self.created_at = datetime.now()

@app.route('/')
def index():
    """Main interface page."""
    return render_template('index.html')

@app.route('/api/browse')
def browse_files():
    """Browse files in /Volumes/Callisto/Movies directory."""
    try:
        path = request.args.get('path', '/Volumes/Callisto/Movies')
        
        if not path.startswith('/Volumes/Callisto/Movies'):
            return jsonify({'error': 'Access denied - path outside allowed directory'}), 403
        
        if not os.path.exists(path):
            return jsonify({'error': 'Path does not exist'}), 404
        
        items = []
        
        # Add parent directory option
        if path != '/Volumes/Callisto/Movies':
            parent_path = str(Path(path).parent)
            if parent_path.startswith('/Volumes/Callisto/Movies'):
                items.append({
                    'name': '..',
                    'path': parent_path,
                    'type': 'directory',
                    'size': None
                })
        
        # List directory contents
        for item in sorted(os.listdir(path)):
            if item.startswith('.'):  # Skip hidden files
                continue
                
            item_path = os.path.join(path, item)
            
            if os.path.isdir(item_path):
                items.append({
                    'name': item,
                    'path': item_path,
                    'type': 'directory',
                    'size': None
                })
            else:
                # Check if it's a video or audio file
                ext = Path(item).suffix.lower()
                video_exts = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm']
                audio_exts = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a']
                
                if ext in video_exts or ext in audio_exts:
                    file_size = os.path.getsize(item_path)
                    items.append({
                        'name': item,
                        'path': item_path,
                        'type': 'video' if ext in video_exts else 'audio',
                        'size': file_size,
                        'sizeFormatted': format_file_size(file_size)
                    })
        
        return jsonify({
            'success': True,
            'currentPath': path,
            'items': items
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

def extract_session_from_filename(filename):
    """Extract session identifier from filename using pattern: 2025-09-03 1, 2025-09-03 2, etc."""
    # Match pattern: YYYY-MM-DD followed by space and number
    match = re.match(r'^(\d{4}-\d{2}-\d{2}\s+\d+)', filename)
    return match.group(1) if match else None

@app.route('/api/auto-detect-audio')
def auto_detect_audio():
    """Auto-detect audio files in the same directory as the master video."""
    try:
        master_path = request.args.get('masterPath')
        if not master_path:
            return jsonify({'error': 'Master path is required'}), 400
        
        if not master_path.startswith('/Volumes/Callisto/Movies'):
            return jsonify({'error': 'Access denied - path outside allowed directory'}), 403
        
        directory = str(Path(master_path).parent)
        master_name = Path(master_path).stem
        
        # Extract session from master filename
        master_session = extract_session_from_filename(master_name)
        
        audio_files = {}
        audio_exts = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a']
        
        # Look for audio files in the same directory
        for item in os.listdir(directory):
            if Path(item).suffix.lower() in audio_exts:
                item_path = os.path.join(directory, item)
                item_name = Path(item).stem.lower()
                
                # If we have a session, only match files from the same session
                if master_session:
                    item_session = extract_session_from_filename(Path(item).stem)
                    if not item_session or item_session != master_session:
                        continue  # Skip files from different sessions
                
                # Try to match audio files to types based on naming patterns
                if 'mic 1' in item_name or 'mic1' in item_name or 'mic audio 1' in item_name:
                    audio_files['mic1'] = item_path
                elif 'mic 2' in item_name or 'mic2' in item_name or 'mic audio 2' in item_name:
                    audio_files['mic2'] = item_path
                elif 'mic 3' in item_name or 'mic3' in item_name or 'mic audio 3' in item_name:
                    audio_files['mic3'] = item_path
                elif 'mic 4' in item_name or 'mic4' in item_name or 'mic audio 4' in item_name:
                    audio_files['mic4'] = item_path
                elif ('mic audio' in item_name and not any(x in item_name for x in ['1', '2', '3', '4'])) or \
                     ('mic' in item_name and 'audio' in item_name and not any(x in item_name for x in ['1', '2', '3', '4'])):
                    # Default mic audio without number goes to mic1
                    if 'mic1' not in audio_files:
                        audio_files['mic1'] = item_path
                elif 'screen' in item_name:
                    audio_files['screen'] = item_path
                elif 'game' in item_name:
                    audio_files['game'] = item_path
                elif 'sound effects' in item_name or 'sfx' in item_name or 'soundeffects' in item_name:
                    audio_files['soundEffects'] = item_path
                elif 'bluetooth' in item_name:
                    audio_files['bluetooth'] = item_path
        
        return jsonify({
            'success': True,
            'audioFiles': audio_files
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/process', methods=['POST'])
def process_video():
    """Process the video files and generate compound clips."""
    try:
        data = request.get_json()
        
        # Validate required fields
        if not data.get('masterVideo'):
            return jsonify({'error': 'Master video file is required'}), 400
        
        # Create a new job
        job_id = str(uuid.uuid4())
        job = ProcessingJob(job_id)
        active_jobs[job_id] = job
        
        # Start processing in background thread
        thread = threading.Thread(
            target=process_video_background,
            args=(job, data)
        )
        thread.start()
        
        return jsonify({
            'success': True,
            'jobId': job_id,
            'message': 'Processing started'
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def format_file_size(size_bytes):
    """Format file size in human readable format."""
    if size_bytes == 0:
        return "0B"
    size_names = ["B", "KB", "MB", "GB", "TB"]
    i = int(math.floor(math.log(size_bytes, 1024)))
    p = math.pow(1024, i)
    s = round(size_bytes / p, 2)
    return f"{s} {size_names[i]}"

def process_video_background(job, data):
    """Background processing function."""
    try:
        # Load configuration
        config = AutoCutStudioConfig('../config/autostudio_config.yaml')
        
        # Extract parameters
        master_video = data['masterVideo']
        audio_sync_settings = data.get('audioSyncSettings', {})  # Individual sync settings
        threshold = data.get('threshold', config.default_threshold)
        
        # Audio sources - map to generator expected keys
        audio_sources = {}
        # The frontend now sends mic1Audio, mic2Audio, etc. directly
        for key in ['mic1Audio', 'mic2Audio', 'mic3Audio', 'mic4Audio', 'screenAudio', 'gameAudio', 'soundEffectsAudio', 'bluetoothAudio']:
            value = data.get(key)
            if value:
                # Convert from "mic1Audio" to "mic1", etc.
                audio_type = key.replace('Audio', '').replace('soundEffects', 'sound_effects')
                audio_sources[audio_type] = value
        
        # Filter out empty audio sources
        audio_sources = {k: v for k, v in audio_sources.items() if v}
        
        job.status = 'processing'
        job.progress = 10
        job.message = 'Running auto-editor to identify cuts...'
        
        # Step 1: Run auto-editor
        editor = AutoEditor(config)
        altered_xml = editor.cut_silence(
            str(master_video), 
            threshold or config.default_threshold
        )
        
        job.progress = 20
        job.message = 'Converting to compound clip structure...'
        
        # Step 2: Convert to compound clip
        compound_xml = editor.convert_to_compound(altered_xml, str(master_video))
        if not compound_xml:
            raise Exception("Failed to create compound clip")
        
        job.progress = 30
        job.message = 'Processing audio sources...'
        
        # Step 3: Process audio files with individual sync settings
        audio_processor = AudioProcessor(config)
        processed_audio = {}
        
        for audio_type, audio_path in audio_sources.items():
            if audio_path:
                try:
                    # Check if this specific audio source needs sync correction
                    apply_sync = audio_sync_settings.get(audio_type, False)
                    
                    processed_path, duration, sample_rate, channels = \
                        audio_processor.process_audio_source(audio_path, apply_sync)
                    processed_audio[audio_type] = {
                        'path': processed_path,
                        'duration': duration,
                        'sample_rate': sample_rate,
                        'channels': channels
                    }
                    
                    sync_status = "with sync" if apply_sync else "without sync"
                    print(f"Processed {audio_type} audio ({sync_status}): {processed_path}")
                    
                except Exception as e:
                    job.message = f"Warning: Failed to process {audio_type} audio: {e}"
                    print(f"Error processing {audio_type}: {e}")  # Add console logging
        
        # Step 4: Generate all compound clips
        generated_clips = []
        progress_per_clip = 50 / 6  # 6 compound types, 50% of progress for compounds
        current_progress = 40
        
        # Build CAM audio sources (mic1, mic2, mic3, mic4, sound_effects)
        cam_audio_sources = {}
        for audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'sound_effects']:
            if audio_type in processed_audio:
                cam_audio_sources[audio_type] = processed_audio[audio_type]['path']
        
        # Store paths for master project generation
        cam_solo_path = None
        cam_dual_path = None
        gs_solo_path = None
        gs_dual_path = None
        ssb_solo_path = None
        ssb_dual_path = None
        
        # Generate CAM Solo compound
        job.progress = current_progress
        job.message = 'Generating CAM Solo compound clip...'
        
        if cam_audio_sources:
            try:
                cam_generator = CamGenerator(config)
                cam_solo_path = cam_generator.generate_cam_compound(
                    compound_xml,
                    cam_audio_sources,
                    'solo',
                    None,
                    False  # Audio already processed with individual sync settings
                )
                generated_clips.append({
                    'type': 'cam_solo',
                    'name': 'CAM - Solo Camera',
                    'path': cam_solo_path,
                    'description': 'Single camera with mic audio and effects'
                })
                print(f"Generated CAM Solo: {cam_solo_path}")  # Add console logging
            except Exception as e:
                job.message = f"Warning: Failed to generate CAM Solo: {e}"
                print(f"Error generating CAM Solo: {e}")  # Add console logging
        
        current_progress += progress_per_clip
        
        # Generate CAM Dual Camera compound
        job.progress = current_progress
        job.message = 'Generating CAM Dual Camera compound clip...'

        if cam_audio_sources:
            try:
                dc_cam_generator = DCCamGenerator(config)
                cam_dual_path = dc_cam_generator.generate_dc_cam_compound(
                    compound_xml,
                    cam_audio_sources,
                    None,
                    False  # Audio already processed
                )
                generated_clips.append({
                    'type': 'cam_dual',
                    'name': 'CAM - Dual Camera',
                    'path': cam_dual_path,
                    'description': 'Dual camera layout with mic audio and effects'
                })
                print(f"Generated CAM Dual: {cam_dual_path}")  # Add console logging
            except Exception as e:
                job.message = f"Warning: Failed to generate CAM Dual: {e}"
                print(f"Error generating CAM Dual: {e}")  # Add console logging
        
        current_progress += progress_per_clip
        
        # Build GS audio sources (all audio - mics, screen, game, sound_effects, bluetooth)
        gs_audio_sources = {}
        for audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'sound_effects', 'bluetooth']:
            if audio_type in processed_audio:
                gs_audio_sources[audio_type] = processed_audio[audio_type]['path']
        
        # Generate GS Solo compound
        job.progress = current_progress
        job.message = 'Generating GS Solo compound clip...'
        
        if gs_audio_sources:
            try:
                gs_generator = GSGenerator(config)
                gs_solo_path = gs_generator.generate_gs_compound(
                    compound_xml,
                    gs_audio_sources,
                    None,  # output_path (use default)
                    False  # apply_audio_sync (already processed)
                )
                generated_clips.append({
                    'type': 'gs_solo',
                    'name': 'GS - Solo Game Share',
                    'path': gs_solo_path,
                    'description': 'Camera, game, screen with full audio mix and effects'
                })
                print(f"Generated GS Solo: {gs_solo_path}")  # Add console logging
            except Exception as e:
                job.message = f"Warning: Failed to generate GS Solo: {e}"
                print(f"Error generating GS Solo: {e}")  # Add console logging
        
        current_progress += progress_per_clip
        
        # Generate GS Dual Camera compound
        job.progress = current_progress
        job.message = 'Generating GS Dual Camera compound clip...'
        
        if gs_audio_sources:
            try:
                dc_gs_generator = DCGSGenerator(config)
                gs_dual_path = dc_gs_generator.generate_dc_gs_compound(
                    compound_xml,
                    gs_audio_sources,
                    None,  # output_path (use default)
                    False  # apply_audio_sync (already processed)
                )
                generated_clips.append({
                    'type': 'gs_dual',
                    'name': 'GS - Dual Camera Game Share',
                    'path': gs_dual_path,
                    'description': 'Dual camera, game, screen with full audio mix and effects'
                })
                print(f"Generated GS Dual: {gs_dual_path}")  # Add console logging
            except Exception as e:
                job.message = f"Warning: Failed to generate GS Dual: {e}"
                print(f"Error generating GS Dual: {e}")  # Add console logging
                        
        current_progress += progress_per_clip
        
        # Build SSB audio sources (screen, game, and bluetooth only)
        ssb_audio_sources = {}
        for audio_type in ['screen', 'game', 'bluetooth']:
            if audio_type in processed_audio:
                ssb_audio_sources[audio_type] = processed_audio[audio_type]['path']
        
        # Generate SSB Solo compound
        job.progress = current_progress
        job.message = 'Generating SSB Solo compound clip...'
        
        if ssb_audio_sources:
            try:
                ssb_generator = SSBGenerator(config)
                ssb_solo_path = ssb_generator.generate_ssb_compound(
                    compound_xml,
                    ssb_audio_sources,
                    'solo',
                    None,
                    False
                )
                generated_clips.append({
                    'type': 'ssb_solo',
                    'name': 'SSB - Solo Screen Share Big',
                    'path': ssb_solo_path,
                    'description': 'Large screen with small camera, screen audio and effects'
                })
                print(f"Generated SSB Solo: {ssb_solo_path}")  # Add console logging
            except Exception as e:
                job.message = f"Warning: Failed to generate SSB Solo: {e}"
                print(f"Error generating SSB Solo: {e}")  # Add console logging
        
        current_progress += progress_per_clip
        
        # Generate SSB Dual Camera compound
        job.progress = current_progress
        job.message = 'Generating SSB Dual Camera compound clip...'
        
        if ssb_audio_sources:
            try:
                dc_ssb_generator = DCSSBGenerator(config)
                ssb_dual_path = dc_ssb_generator.generate_dc_ssb_compound(
                    compound_xml,
                    ssb_audio_sources,
                    None,
                    False
                )
                generated_clips.append({
                    'type': 'ssb_dual',
                    'name': 'SSB - Dual Camera Screen Share Big',
                    'path': ssb_dual_path,
                    'description': 'Large screen with dual cameras, screen audio and effects'
                })
                print(f"Generated SSB Dual: {ssb_dual_path}")  # Add console logging
            except Exception as e:
                job.message = f"Warning: Failed to generate SSB Dual: {e}"
                print(f"Error generating SSB Dual: {e}")  # Add console logging
        
        # Step 5: Generate Master Projects
        job.progress = 90
        job.message = 'Generating master projects...'
        
        # Get original name from master video path
        original_name = Path(master_video).stem.replace(' master', '')
        
        # Debug logging
        print(f"Master project generation - Original name: {original_name}")
        print(f"Available paths - CAM Solo: {cam_solo_path}, GS Solo: {gs_solo_path}, SSB Solo: {ssb_solo_path}")
        print(f"Available paths - CAM Dual: {cam_dual_path}, GS Dual: {gs_dual_path}, SSB Dual: {ssb_dual_path}")
        
        # Create master project generator
        from core.compound_generators.master_project_generator import MasterProjectGenerator
        master_generator = MasterProjectGenerator(config)
        
        # Generate SOLO master project (if we have the required compounds)
        if cam_solo_path and gs_solo_path and ssb_solo_path:
            try:
                print(f"Generating SOLO master project...")
                solo_master_path = master_generator.generate_solo_master_project(
                    cam_solo_path, gs_solo_path, ssb_solo_path, original_name
                )
                generated_clips.append({
                    'type': 'master',
                    'name': f'{original_name} - SOLO Master Project',
                    'path': solo_master_path,
                    'description': 'Complete project with CAM, GS, and SSB on separate lanes with detached audio'
                })
                print(f"Successfully generated SOLO master: {solo_master_path}")
            except Exception as e:
                error_msg = f"Failed to generate SOLO master project: {e}"
                job.message = f"Warning: {error_msg}"
                print(f"Error: {error_msg}")
                import traceback
                print(traceback.format_exc())  # Print full traceback for debugging
        else:
            print(f"Skipping SOLO master - missing required compounds")
        
        # Generate DC master project (if we have the required compounds)
        if cam_dual_path and gs_dual_path and ssb_dual_path:
            try:
                print(f"Generating DC master project...")
                dc_master_path = master_generator.generate_dc_master_project(
                    cam_dual_path, gs_dual_path, ssb_dual_path, original_name
                )
                generated_clips.append({
                    'type': 'master',
                    'name': f'{original_name} - DC Master Project',
                    'path': dc_master_path,
                    'description': 'Complete dual camera project with DC CAM, DC GS, and DC SSB on separate lanes'
                })
                print(f"Successfully generated DC master: {dc_master_path}")
            except Exception as e:
                error_msg = f"Failed to generate DC master project: {e}"
                job.message = f"Warning: {error_msg}"
                print(f"Error: {error_msg}")
                import traceback
                print(traceback.format_exc())  # Print full traceback for debugging
        else:
            print(f"Skipping DC master - missing required compounds")
        
        # Complete
        job.status = 'completed'
        job.progress = 100
        job.message = f'Successfully generated {len(generated_clips)} files'
        job.results = generated_clips
        
        print(f"Processing complete - Generated {len(generated_clips)} total files")
        
    except Exception as e:
        job.status = 'error'
        job.error = str(e)
        job.message = f'Error: {str(e)}'
        print(f"Fatal error in processing: {e}")
        import traceback
        print(traceback.format_exc())
                        
@app.route('/api/job/<job_id>')
def get_job_status(job_id):
    """Get the status of a processing job."""
    if job_id not in active_jobs:
        return jsonify({'error': 'Job not found'}), 404
    
    job = active_jobs[job_id]
    
    return jsonify({
        'id': job.id,
        'status': job.status,
        'progress': job.progress,
        'message': job.message,
        'error': job.error,
        'results': job.results,
        'createdAt': job.created_at.isoformat()
    })

@app.route('/api/download/<path:filename>')
def download_file(filename):
    """Download generated XML files."""
    try:
        # Security: only allow downloading files in output directory
        file_path = Path(filename)
        if not file_path.exists():
            return jsonify({'error': 'File not found'}), 404
        
        return send_file(str(file_path), as_attachment=True)
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/test-config')
def test_config():
    """Test configuration and CLI library access."""
    try:
        config = AutoCutStudioConfig('../config/autostudio_config.yaml')
        
        return jsonify({
            'success': True,
            'message': 'Configuration loaded successfully',
            'configPath': str(config.config_path),
            'defaultThreshold': config.default_threshold,
            'currentLayout': config.current_layout
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
    
@app.errorhandler(404)
def not_found(error):
    return render_template('404.html'), 404
    
@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5555)