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
import { AudioEditorComponent } from './components/audio-editor/audio-editor.component';
import { RelinkingComponent } from './components/relinking/relinking.component';
import { AudioDuckingComponent } from './components/audio-ducking/audio-ducking.component';
import { SettingsComponent } from './components/settings/settings.component';
import { SetupComponent } from './components/setup/setup.component';

@NgModule({
  declarations: [
    AppComponent,
    SetupComponent,
    WorkflowComponent,
    FileBrowserComponent,
    AudioSourcesComponent,
    ConsoleOutputComponent,
    ResultsComponent,
    AudioEditorComponent,
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
