import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { WorkflowComponent } from './components/workflow/workflow.component';
import { AudioEditorComponent } from './components/audio-editor/audio-editor.component';

const routes: Routes = [
  { path: '', redirectTo: '/workflow', pathMatch: 'full' },
  { path: 'workflow', component: WorkflowComponent },
  { path: 'audio-editor', component: AudioEditorComponent },
  { path: '**', redirectTo: '/workflow' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes, { useHash: false })],
  exports: [RouterModule]
})
export class AppRoutingModule { }
