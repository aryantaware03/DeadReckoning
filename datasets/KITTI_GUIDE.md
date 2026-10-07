# Real-dataset plug-in guide (KITTI / EuRoC) — prototype runs without this

The demo works fully on synthetic data. To attach a real dataset later:

1. Download KITTI odometry (http://www.cvlibs.net/datasets/kitti/eval_odometry.php)
   or EuRoC MAV (https://projects.asl.ethz.ch/datasets/doku.php?id=kmavvisualinertialdatasets).
2. Implement `load_kitti(path)` in `datasets/dataset_loader.py` so it returns the
   same dict as `simulation/sensor_simulator.run_truth()`:
   `t, ax, ay, az, gx, gy, gz, v_front, v_rear, slip, gps_ok, gps_x, gps_y, x, y, yaw, v`.
   - KITTI: use `oxts` (IMU/GPS) + tracklet ground truth; mark `gps_ok=False`
     inside known outage segments to replay tunnel behaviour.
   - EuRoC: use `mav0/imu0` + `mav0/state_groundtruth`; same mapping.
3. The ESKF + Bi-LSTM consume that dict unchanged (`eskf/eskf_15state.run_filters`,
   `models/bilstm.Predictor.priors_for_run`), so no filter code changes.
4. Frontend: `Ops → Dataset Playback` already reads the CSV schema from
   `describe_expected_schema()` — export any dataset to that CSV to replay it
   in the 3D console.
