# cli/main.py

import argparse
import sys
from pathlib import Path
import os

# Add parent directory to path to import core modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.config import AutoCutStudioConfig
from core.compound_generators.cam_generator import CamGenerator
from core.compound_generators.gs_generator import GSGenerator
from core.compound_generators.ssb_generator import SSBGenerator
from core.compound_generators.dc_cam_generator import DCCamGenerator
from core.compound_generators.dc_gs_generator import DCGSGenerator
from core.compound_generators.dc_ssb_generator import DCSSBGenerator
from core.audio_processor import AudioProcessor
from core.editors.auto_editor import AutoEditor

def create_parser():
    """Create the main argument parser."""
    parser = argparse.ArgumentParser(description='AutoCutStudio - Automated YouTube video editing tool')
    parser.add_argument('--config', '-c', help='Path to config file')
    
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # Complete workflow command - start to finish
    workflow_parser = subparsers.add_parser('workflow', help='Complete workflow: auto-editor -> compound -> cam')
    workflow_parser.add_argument('--master', required=True, help='Path to master video file')
    workflow_parser.add_argument('--mic-audio', required=True, help='Path to mic audio file')
    workflow_parser.add_argument('--threshold', '-t', help='Audio threshold for auto-editor (e.g., -40dB)')
    workflow_parser.add_argument('--mode', choices=['solo', 'dual'], default='solo', help='Camera mode')
    workflow_parser.add_argument('--sync-audio', action='store_true', help='Apply 29.97fps audio sync correction')
    workflow_parser.add_argument('--output-dir', help='Output directory for generated files')
    
    # Generate cam command (for existing compound clips)
    cam_parser = subparsers.add_parser('generate-cam', help='Generate cam compound clip from existing compound')
    cam_parser.add_argument('--compound', required=True, help='Path to compound clip XML file')
    cam_parser.add_argument('--mic-audio', required=True, help='Path to mic audio file')
    cam_parser.add_argument('--mode', choices=['solo', 'dual'], default='solo', help='Camera mode')
    cam_parser.add_argument('--output', '-o', help='Output path for generated XML')
    cam_parser.add_argument('--sync-audio', action='store_true', help='Apply 29.97fps audio sync correction')
    
    # Generate gs command (for existing compound clips)
    gs_parser = subparsers.add_parser('generate-gs', help='Generate gs compound clip from existing compound')
    gs_parser.add_argument('--compound', required=True, help='Path to compound clip XML file')
    gs_parser.add_argument('--mic-audio', help='Path to mic audio file')
    gs_parser.add_argument('--screen-audio', help='Path to screen audio file')
    gs_parser.add_argument('--game-audio', help='Path to game audio file')
    gs_parser.add_argument('--mode', choices=['solo', 'dual'], default='solo', help='Camera mode')
    gs_parser.add_argument('--output', '-o', help='Output path for generated XML')
    gs_parser.add_argument('--sync-audio', action='store_true', help='Apply 29.97fps audio sync correction')
    
    # Generate ssb command (for existing compound clips)
    ssb_parser = subparsers.add_parser('generate-ssb', help='Generate ssb compound clip from existing compound')
    ssb_parser.add_argument('--compound', required=True, help='Path to compound clip XML file')
    ssb_parser.add_argument('--screen-audio', required=True, help='Path to screen audio file')
    ssb_parser.add_argument('--mode', choices=['solo', 'dual'], default='solo', help='Camera mode')
    ssb_parser.add_argument('--output', '-o', help='Output path for generated XML')
    ssb_parser.add_argument('--sync-audio', action='store_true', help='Apply 29.97fps audio sync correction')
    
    # Generate dual camera cam command (for existing compound clips)
    dc_cam_parser = subparsers.add_parser('generate-dc-cam', help='Generate dual camera cam compound clip from existing compound')
    dc_cam_parser.add_argument('--compound', required=True, help='Path to compound clip XML file')
    dc_cam_parser.add_argument('--mic-audio', required=True, help='Path to mic audio file')
    dc_cam_parser.add_argument('--output', '-o', help='Output path for generated XML')
    dc_cam_parser.add_argument('--sync-audio', action='store_true', help='Apply 29.97fps audio sync correction')
    
    # Generate dual camera gs command (for existing compound clips)
    dc_gs_parser = subparsers.add_parser('generate-dc-gs', help='Generate dual camera gs compound clip from existing compound')
    dc_gs_parser.add_argument('--compound', required=True, help='Path to compound clip XML file')
    dc_gs_parser.add_argument('--mic-audio', help='Path to mic audio file')
    dc_gs_parser.add_argument('--screen-audio', help='Path to screen audio file')
    dc_gs_parser.add_argument('--game-audio', help='Path to game audio file')
    dc_gs_parser.add_argument('--output', '-o', help='Output path for generated XML')
    dc_gs_parser.add_argument('--sync-audio', action='store_true', help='Apply 29.97fps audio sync correction')
    
    # Generate dual camera ssb command (for existing compound clips)
    dc_ssb_parser = subparsers.add_parser('generate-dc-ssb', help='Generate dual camera ssb compound clip from existing compound')
    dc_ssb_parser.add_argument('--compound', required=True, help='Path to compound clip XML file')
    dc_ssb_parser.add_argument('--screen-audio', required=True, help='Path to screen audio file')
    dc_ssb_parser.add_argument('--output', '-o', help='Output path for generated XML')
    dc_ssb_parser.add_argument('--sync-audio', action='store_true', help='Apply 29.97fps audio sync correction')
    
    # Sync audio command
    sync_parser = subparsers.add_parser('sync-audio', help='Apply 29.97fps sync correction to audio')
    sync_parser.add_argument('--input', required=True, help='Input audio file')
    sync_parser.add_argument('--output', required=True, help='Output audio file')
    
    # Extract audio command
    extract_parser = subparsers.add_parser('extract-audio', help='Extract audio from video file')
    extract_parser.add_argument('--input', required=True, help='Input video file')
    extract_parser.add_argument('--output', help='Output audio file')
    
    return parser

def handle_workflow(args, config):
    """Handle complete workflow command: master -> auto-editor -> compound -> cam."""
    try:
        # Validate input files
        master_path = Path(args.master)
        mic_audio_path = Path(args.mic_audio)
        
        if not master_path.exists():
            print(f"Error: Master video file not found: {master_path}")
            return 1
        
        if not mic_audio_path.exists():
            print(f"Error: Mic audio file not found: {mic_audio_path}")
            return 1
        
        # Set up output directory
        if args.output_dir:
            output_dir = Path(args.output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)
        else:
            output_dir = master_path.parent
        
        print("=" * 60)
        print("AutoCutStudio Complete Workflow")
        print("=" * 60)
        print(f"Master file: {master_path}")
        print(f"Mic audio: {mic_audio_path}")
        print(f"Mode: {args.mode}")
        print(f"Threshold: {args.threshold or config.default_threshold}")
        print(f"Output directory: {output_dir}")
        print("")
        
        # Step 1: Run auto-editor
        print("Step 1: Running auto-editor to identify cuts...")
        editor = AutoEditor(config)
        altered_xml = editor.cut_silence(
            str(master_path), 
            args.threshold or config.default_threshold
        )
        print(f"Auto-editor complete: {altered_xml}")
        print("")
        
        # Step 2: Convert to compound clip
        print("Step 2: Converting to compound clip structure...")
        compound_xml = editor.convert_to_compound(altered_xml, str(master_path))
        if not compound_xml:
            print("Error: Failed to create compound clip")
            return 1
        print(f"Compound clip created: {compound_xml}")
        print("")
        
        # Step 3: Generate cam compound
        print("Step 3: Generating cam compound clip...")
        cam_generator = CamGenerator(config)
        cam_xml = cam_generator.generate_cam_compound(
            compound_xml,
            str(mic_audio_path),
            args.mode,
            None,  # Auto-generate output path
            args.sync_audio
        )
        print(f"Cam compound created: {cam_xml}")
        print("")
        
        print("=" * 60)
        print("WORKFLOW COMPLETE!")
        print("=" * 60)
        print("Generated files:")
        print(f"  1. Auto-editor cuts:    {altered_xml}")
        print(f"  2. Base compound:       {compound_xml}")
        print(f"  3. Cam compound:        {cam_xml}")
        print("")
        print("Next steps:")
        print("1. Import the cam compound XML into Final Cut Pro X")
        print("2. Use the timeline to toggle between different cuts")
        print("3. Add additional compound types (gs, ssb) as needed")
        
        return 0
        
    except Exception as e:
        print(f"Error in workflow: {e}")
        return 1

def handle_generate_cam(args, config):
    """Handle generate-cam command."""
    try:
        # Validate input files
        compound_path = Path(args.compound)
        mic_audio_path = Path(args.mic_audio)
        
        if not compound_path.exists():
            print(f"Error: Compound XML file not found: {compound_path}")
            return 1
        
        if not mic_audio_path.exists():
            print(f"Error: Mic audio file not found: {mic_audio_path}")
            return 1
        
        # Create cam generator
        cam_generator = CamGenerator(config)
        
        # Generate cam compound clip
        output_path = cam_generator.generate_cam_compound(
            str(compound_path),
            str(mic_audio_path),
            args.mode,
            args.output,
            args.sync_audio
        )
        
        print(f"Success! Cam compound clip generated: {output_path}")
        print("\nNext steps:")
        print("1. Import the XML file into Final Cut Pro X")
        print("2. The cam compound clip will be available in your event")
        print("3. Use the main timeline to switch between cuts")
        
        return 0
        
    except Exception as e:
        print(f"Error generating cam compound clip: {e}")
        return 1

def handle_sync_audio(args, config):
    """Handle sync-audio command."""
    try:
        input_path = Path(args.input)
        if not input_path.exists():
            print(f"Error: Input audio file not found: {input_path}")
            return 1
        
        audio_processor = AudioProcessor(config)
        output_path = audio_processor.sync_audio_for_2997fps(str(input_path), args.output)
        
        print(f"Success! Audio synced: {output_path}")
        return 0
        
    except Exception as e:
        print(f"Error syncing audio: {e}")
        return 1

def handle_extract_audio(args, config):
    """Handle extract-audio command."""
    try:
        input_path = Path(args.input)
        if not input_path.exists():
            print(f"Error: Input video file not found: {input_path}")
            return 1
        
        audio_processor = AudioProcessor(config)
        output_path = audio_processor.extract_audio_from_video(str(input_path), args.output)
        
        print(f"Success! Audio extracted: {output_path}")
        return 0
        
    except Exception as e:
        print(f"Error extracting audio: {e}")
        return 1

def main():
    """Main entry point."""
    parser = create_parser()
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    try:
        # Load configuration
        config = AutoCutStudioConfig(args.config)
        print(f"Loaded config from: {config.config_path}")
        
        # Route to appropriate handler
        if args.command == 'workflow':
            return handle_workflow(args, config)
        elif args.command == 'generate-cam':
            return handle_generate_cam(args, config)
        elif args.command == 'generate-gs':
            return GSGenerator.handle_generate_gs(args, config)
        elif args.command == 'generate-ssb':
            return SSBGenerator.handle_generate_ssb(args, config)
        elif args.command == 'generate-dc-cam':
            return DCCamGenerator.handle_generate_dc_cam(args, config)
        elif args.command == 'generate-dc-gs':
            return DCGSGenerator.handle_generate_dc_gs(args, config)
        elif args.command == 'generate-dc-ssb':
            return DCSSBGenerator.handle_generate_dc_ssb(args, config)
        elif args.command == 'sync-audio':
            return handle_sync_audio(args, config)
        elif args.command == 'extract-audio':
            return handle_extract_audio(args, config)
        else:
            print(f"Unknown command: {args.command}")
            return 1
            
    except FileNotFoundError as e:
        print(f"Error: {e}")
        print("Please create a config file or specify one with --config")
        return 1
    except Exception as e:
        print(f"Unexpected error: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())