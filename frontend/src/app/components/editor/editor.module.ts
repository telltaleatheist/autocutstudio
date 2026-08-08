// src/app/components/editor/editor.module.ts
//
// The timeline editor as a self-contained Angular feature module. Everything the
// editor declares lives under this folder; the host app only has to import
// EditorModule (EditorComponent is exported for the router).
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { EditorComponent } from './editor.component';
import { ProjectSidebarComponent } from './project-sidebar/project-sidebar.component';
import { ProjectSetupModalComponent } from './project-setup-modal/project-setup-modal.component';
import { ActivityDockComponent } from './activity-dock/activity-dock.component';
import { ExportModalsComponent } from './export-modals/export-modals.component';
import { TranscriptPaneComponent } from './transcript-pane/transcript-pane.component';
import { ProjectsService } from './services/projects.service';

@NgModule({
  declarations: [
    EditorComponent,
    ProjectSidebarComponent,
    ProjectSetupModalComponent,
    ActivityDockComponent,
    ExportModalsComponent,
    TranscriptPaneComponent
  ],
  imports: [
    CommonModule,
    FormsModule
  ],
  exports: [
    EditorComponent,
    ProjectSidebarComponent,
    ProjectSetupModalComponent,
    ActivityDockComponent,
    ExportModalsComponent,
    TranscriptPaneComponent
  ],
  providers: [ProjectsService]
})
export class EditorModule { }
