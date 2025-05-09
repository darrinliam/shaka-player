/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.media.VideoWrapper');
goog.provide('shaka.media.VideoWrapper.PlayheadMover');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.IReleasable');
goog.require('shaka.util.MediaReadyState');
goog.require('shaka.util.Timer');


/**
 * Creates a new VideoWrapper that manages setting current time and playback
 * rate.  This handles seeks before content is loaded and ensuring the video
 * time is set properly.  This doesn't handle repositioning within the
 * presentation window.
 *
 * @implements {shaka.util.IReleasable}
 */
shaka.media.VideoWrapper = class {
  /**
   * @param {!HTMLMediaElement} video
   * @param {function()} onSeek Called when the video seeks.
   * @param {function(number)} onStarted Called when the video has started.
   * @param {function():number} getStartTime Called to get the time to start at.
   */
  constructor(video, onSeek, onStarted, getStartTime) {
    /** @private {HTMLMediaElement} */
    this.video_ = video;

    /** @private {function()} */
    this.onSeek_ = onSeek;

    /** @private {function(number)} */
    this.onStarted_ = onStarted;

    /** @private {?number} */
    this.startTime_ = null;

    /** @private {function():number} */
    this.getStartTime_ = () => {
      if (this.startTime_ == null) {
        this.startTime_ = getStartTime();
      }
      return this.startTime_;
    };

    /** @private {boolean} */
    this.started_ = false;

    /** @private {shaka.util.EventManager} */
    this.eventManager_ = new shaka.util.EventManager();

    /** @private {shaka.media.VideoWrapper.PlayheadMover} */
    this.mover_ = new shaka.media.VideoWrapper.PlayheadMover(
        /* mediaElement= */ video,
        /* maxAttempts= */ 10);

    // Before we can set the start time, we must check if the video element is
    // ready. If the video element is not ready, we cannot set the time. To work
    // around this, we will wait for the "loadedmetadata" event which tells us
    // that the media element is now ready.
    shaka.util.MediaReadyState.waitForReadyState(this.video_,
        HTMLMediaElement.HAVE_METADATA,
        this.eventManager_,
        () => {
          this.setStartTime_(this.getStartTime_());
        });
  }


  /** @override */
  release() {
    if (this.eventManager_) {
      this.eventManager_.release();
      this.eventManager_ = null;
    }

    if (this.mover_ != null) {
      this.mover_.release();
      this.mover_ = null;
    }

    this.onSeek_ = () => {};
    this.video_ = null;
  }


  /**
   * Gets the video's current (logical) position.
   *
   * @return {number}
   */
  getTime() {
    return this.started_ ? this.video_.currentTime : this.getStartTime_();
  }


  /**
   * Sets the current time of the video.
   *
   * @param {number} time
   */
  setTime(time) {
    if (this.video_.readyState > 0) {
      this.mover_.moveTo(time);
    } else {
      shaka.util.MediaReadyState.waitForReadyState(this.video_,
          HTMLMediaElement.HAVE_METADATA,
          this.eventManager_,
          () => {
            this.setStartTime_(this.getStartTime_());
          });
    }
  }


  /**
   * Set the start time for the content. The given start time will be ignored if
   * the content does not start at 0.
   *
   * @param {number} startTime
   * @private
   */
  setStartTime_(startTime) {
    // If we start close enough to our intended start time, then we won't do
    // anything special.
    if (Math.abs(this.video_.currentTime - startTime) < 0.001) {
      this.startListeningToSeeks_();
      return;
    }

    // We will need to delay adding our normal seeking listener until we have
    // seen the first seek event. We will force the first seek event later in
    // this method.
    this.eventManager_.listenOnce(this.video_, 'seeking', () => {
      this.startListeningToSeeks_();
    });

    // If the currentTime != 0, it indicates that the user has seeked after
    // calling |Player.load|, meaning that |currentTime| is more meaningful than
    // |startTime|.
    //
    // Seeking to the current time is a work around for Issue 1298 and 4888.
    // If we don't do this, the video may get stuck and not play.
    //
    // TODO: Need further investigation why it happens. Before and after
    // setting the current time, video.readyState is 1, video.paused is true,
    // and video.buffered's TimeRanges length is 0.
    // See: https://github.com/shaka-project/shaka-player/issues/1298
    this.mover_.moveTo(
        (!this.video_.currentTime || this.video_.currentTime == 0) ?
        startTime :
        this.video_.currentTime);
  }


  /**
   * Add the listener for seek-events. This will call the externally-provided
   * |onSeek| callback whenever the media element seeks.
   *
   * @private
   */
  startListeningToSeeks_() {
    goog.asserts.assert(
        this.video_.readyState > 0,
        'The media element should be ready before we listen for seeking.');

    // Now that any startup seeking is complete, we can trust the video element
    // for currentTime.
    this.started_ = true;

    this.eventManager_.listen(this.video_, 'seeking', () => this.onSeek_());
    this.onStarted_(this.video_.currentTime);
  }
};

/**
 * A class used to move the playhead away from its current time.  Sometimes,
 * legacy Edge ignores re-seeks. After changing the current time, check every
 * 100ms, retrying if the change was not accepted.
 *
 * Delay stats over 100 runs of a re-seeking integration test:
 *   Edge   -   0ms -   2%
 *   Edge   - 100ms -  40%
 *   Edge   - 200ms -  32%
 *   Edge   - 300ms -  24%
 *   Edge   - 400ms -   2%
 *   Chrome -   0ms - 100%
 *
 * Unfortunately, legacy Edge is not receiving updates anymore, but it still
 * must be supported as it is used for web browsers on XBox.
 *
 * @implements {shaka.util.IReleasable}
 * @final
 */
shaka.media.VideoWrapper.PlayheadMover = class {
  /**
   * @param {!HTMLMediaElement} mediaElement
   *    The media element that the mover can manipulate.
   *
   * @param {number} maxAttempts
   *    To prevent us from infinitely trying to change the current time, the
   *    mover accepts a max attempts value. At most, the mover will check if the
   *    video moved |maxAttempts| times. If this is zero of negative, no
   *    attempts will be made.
   */
  constructor(mediaElement, maxAttempts) {
    /** @private {HTMLMediaElement} */
    this.mediaElement_ = mediaElement;

    /** @private {number} */
    this.maxAttempts_ = maxAttempts;

    /** @private {number} */
    this.remainingAttempts_ = 0;

    /** @private {number} */
    this.originTime_ = 0;

    /** @private {number} */
    this.targetTime_ = 0;

    /** @private {shaka.util.Timer} */
    this.timer_ = new shaka.util.Timer(() => this.onTick_());
  }

  /** @override */
  release() {
    if (this.timer_) {
      this.timer_.stop();
      this.timer_ = null;
    }

    this.mediaElement_ = null;
  }

  /**
   * Try forcing the media element to move to |timeInSeconds|. If a previous
   * call to |moveTo| is still in progress, this will override it.
   *
   * @param {number} timeInSeconds
   */
  moveTo(timeInSeconds) {
    this.originTime_ = this.mediaElement_.currentTime;
    this.targetTime_ = timeInSeconds;

    this.remainingAttempts_ = this.maxAttempts_;

    // Set the time and then start the timer. The timer will check if the set
    // was successful, and retry if not.
    this.mediaElement_.currentTime = timeInSeconds;
    this.timer_.tickEvery(/* seconds= */ 0.1);
  }

  /**
   * @private
   */
  onTick_() {
    // Sigh... We ran out of retries...
    if (this.remainingAttempts_ <= 0) {
      shaka.log.warning([
        'Failed to move playhead from', this.originTime_,
        'to', this.targetTime_,
      ].join(' '));

      this.timer_.stop();
      return;
    }

    // Yay! We were successful.
    if (this.mediaElement_.currentTime != this.originTime_ ||
        this.mediaElement_.currentTime === this.targetTime_) {
      this.timer_.stop();
      return;
    }

    // Sigh... Try again...
    this.mediaElement_.currentTime = this.targetTime_;
    this.remainingAttempts_--;
  }
};
