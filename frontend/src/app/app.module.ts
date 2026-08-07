import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { WorkflowComponent } from './components/workflow/workflow.component';
import { FileBrowserComponent } from './components/file-browser/file-browser.component';
import { AudioSourcesComponent } from './components/audio-sources/audio-sources.component';
import { ConsoleOutputComponent } from './components/console-output/console-output.component';
import { ResultsComponent } from './components/results/results.component';
import { RelinkingComponent } from './components/relinking/relinking.component';
import { AudioDuckingComponent } from './components/audio-ducking/audio-ducking.component';
import { SettingsComponent } from './components/settings/settings.component';
import { SetupComponent } from './components/setup/setup.component';
import { AlignmentComponent } from './components/alignment/alignment.component';
import { EditorComponent } from './components/editor/editor.component';
import { MetadataComponent } from './components/metadata/metadata.component';
import { MetadataReportsComponent } from './components/metadata-reports/metadata-reports.component';
import { ProjectSidebarComponent } from './components/project-sidebar/project-sidebar.component';
import { ActivityDockComponent } from './components/editor/activity-dock/activity-dock.component';
import { ExportModalsComponent } from './components/editor/export-modals/export-modals.component';
import { TranscriptPaneComponent } from './components/editor/transcript-pane/transcript-pane.component';
import { ProjectSetupModalComponent } from './components/project-setup-modal/project-setup-modal.component';

@NgModule({
  declarations: [
    AppComponent,
    SetupComponent,
    AlignmentComponent,
    EditorComponent,
    ProjectSidebarComponent,
    ActivityDockComponent,
    ExportModalsComponent,
    TranscriptPaneComponent,
    ProjectSetupModalComponent,
    MetadataComponent,
    MetadataReportsComponent,
    WorkflowComponent,
    FileBrowserComponent,
    AudioSourcesComponent,
    ConsoleOutputComponent,
    ResultsComponent,
    RelinkingComponent,
    AudioDuckingComponent,
    SettingsComponent
  ],
  imports: [
    BrowserModule,
    FormsModule,
    AppRoutingModule
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule { }
