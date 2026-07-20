import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { WorkflowComponent } from './components/workflow/workflow.component';
import { AudioEditorComponent } from './components/audio-editor/audio-editor.component';
import { RelinkingComponent } from './components/relinking/relinking.component';
import { AudioDuckingComponent } from './components/audio-ducking/audio-ducking.component';
import { SettingsComponent } from './components/settings/settings.component';
import { AlignmentComponent } from './components/alignment/alignment.component';
import { EditorLauncherComponent } from './components/editor-launcher/editor-launcher.component';
import { EditorComponent } from './components/editor/editor.component';

const routes: Routes = [
  { path: '', redirectTo: '/workflow', pathMatch: 'full' },
  { path: 'workflow', component: WorkflowComponent },
  { path: 'audio-editor', component: AudioEditorComponent },
  { path: 'audio-ducking', component: AudioDuckingComponent },
  { path: 'relinking', component: RelinkingComponent },
  { path: 'editor-launcher', component: EditorLauncherComponent },
  { path: 'settings', component: SettingsComponent },
  // Manual-alignment wizard — opened in its OWN window, deep-linked via a hash
  // fragment (#/alignment). Hash routing is required for reliable deep-linking over
  // file://; the main window still boots '' → /workflow via the redirect above.
  { path: 'alignment', component: AlignmentComponent },
  // Timeline editor — opened in its OWN chromeless window, deep-linked via #/editor
  // (same hash-routing rationale as the alignment wizard).
  { path: 'editor', component: EditorComponent },
  { path: '**', redirectTo: '/workflow' }
];

@NgModule({
  // useHash: true so the alignment window can deep-link to #/alignment over file://.
  imports: [RouterModule.forRoot(routes, { useHash: true })],
  exports: [RouterModule]
})
export class AppRoutingModule { }
