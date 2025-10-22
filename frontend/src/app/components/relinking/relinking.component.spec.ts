import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RelinkingComponent } from './relinking.component';

describe('RelinkingComponent', () => {
  let component: RelinkingComponent;
  let fixture: ComponentFixture<RelinkingComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [RelinkingComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(RelinkingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
