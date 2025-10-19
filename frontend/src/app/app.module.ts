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

@NgModule({
  declarations: [
    AppComponent,
    WorkflowComponent,
    FileBrowserComponent,
    AudioSourcesComponent,
    ConsoleOutputComponent,
    ResultsComponent
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
